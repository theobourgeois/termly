/**
 * Refreshes one university's timetable and course details in Supabase.
 *
 *     node refresh.js dal                    # timetable, then every course's description and requisites
 *     node refresh.js dal --details missing  # only fetch details for courses that have none
 *     node refresh.js dal --details none     # timetable only, a few minutes
 *     node refresh.js dal --dry-run          # scrape and check, save nothing; details for a sample of courses
 *     node refresh.js dal --force            # save even if the health checks fail, when the change is real
 *
 * Each university has a scraper in universities/<id>.js exporting scrapeTimetable() and, if its
 * calendar can be read, scrapeCourseDetails(). See lib/import.js for what they return.
 *
 * Every run that isn't a dry run is recorded in refresh_runs, with what lib/health.js found. A dry
 * run only needs the publishable key, so it can be run by anyone (or any agent) without write access.
 *
 * When the university's server doesn't answer, the run is recorded as "unreachable" and exits
 * successfully with a warning: the school is down, the scraper isn't broken. triage.js only reports
 * it if it lasts.
 */
import { pathToFileURL } from "node:url";
import { checkHealth, measure } from "./lib/health.js";
import { connect, isUnreachable, log, zonedToUtc } from "./lib/import.js";

const SUBJECTS_PER_IMPORT = 20;
// Limit the work per API call to reduce statement timeouts when universities import together.
// Keep each term/subject whole: splitting it would delete sections saved by earlier pieces.
// A single subject within one term can therefore exceed this target.
const SECTIONS_PER_IMPORT = 400;
// How many courses a dry run fetches details for.
const DETAILS_SAMPLE = 20;

class HealthError extends Error {
    constructor(failures) {
        super(`Health checks failed, not saving: ${failures.join("; ")}`);
        this.problems = failures;
    }
}

class UnreachableError extends Error {
    constructor(error) {
        const messages = [];
        for (let cause = error; cause; cause = cause.cause) messages.push(cause.message);
        super(`Couldn't reach the university's server, not saving: ${messages.join(": ")}`, { cause: error });
    }
}

function parseArgs(argv) {
    const [university, ...rest] = argv;
    if (!university || !/^[a-z0-9-]+$/.test(university)) {
        throw new Error("Usage: node refresh.js <university> [--details all|missing|none] [--dry-run] [--force]");
    }
    const flag = rest.indexOf("--details");
    const details = flag === -1 ? "all" : rest[flag + 1];
    if (!["all", "missing", "none"].includes(details)) throw new Error("--details is all, missing or none");
    return { university, details, dryRun: rest.includes("--dry-run"), force: rest.includes("--force") };
}

/** Runs the health checks against the last run that saved, and logs what they found. */
async function check(db, university, metrics) {
    const [baseline, storedSections] = await Promise.all([
        lastSavedMetrics(db, university),
        db.count("catalog_sections", { university_id: `eq.${university}` }),
    ]);
    log(`Scraped ${metrics.sections} sections in ${Object.keys(metrics.terms).length} terms; ${storedSections} stored`);
    for (const [code, term] of Object.entries(metrics.terms)) {
        const share = (count) => `${Math.round((100 * count) / Math.max(term.sections, 1))}%`;
        log(
            `  ${term.name} (${code}): ${term.sections} sections; ${share(term.withTimes)} with times, ` +
                `${share(term.withInstructors)} with instructors, ${share(term.withRooms)} with rooms`,
        );
    }
    if (!baseline) log("No earlier run to compare with");
    const result = checkHealth(metrics, { baseline, storedSections, today: new Date().toISOString().slice(0, 10) });
    for (const failure of result.failures) log(`Failed check: ${failure}`);
    for (const warning of result.warnings) log(`Warning: ${warning}`);
    return result;
}

export async function importTimetable(db, university, timetable) {
    // Saving nothing would delete every section, so not even --force does it.
    if (timetable.sections.length === 0) throw new Error("Scraped no sections, not saving");
    const listedCodes = timetable.terms.map((term) => term.code);

    await db.rpc("import_terms", { p_university: university, p_terms: timetable.terms });
    // A subject that's stored but no longer on the timetable has had all its sections removed, so it
    // goes in the scope with no sections. Subjects that failed to download are left out and keep theirs.
    const storedSubjects = await db.selectAll("subjects", "code", { university_id: `eq.${university}` }, "code");
    const failed = new Set(timetable.failedSubjects);
    const scraped = new Map(timetable.subjects.map((subject) => [subject.code, subject]));
    const subjectCodes = [...new Set([...scraped.keys(), ...storedSubjects.map((subject) => subject.code)])]
        .filter((code) => !failed.has(code))
        .sort();
    if (failed.size) log(`Keeping stored sections for subjects that failed: ${[...failed].join(", ")}`);

    const totals = { sections: 0, changed: 0, deleted: 0 };
    for (const { term, codes } of importChunks(subjectCodes, timetable)) {
        const inChunk = new Set(codes);
        const courses = timetable.courses.filter((course) => inChunk.has(course.subject_code));
        const courseCodes = new Set(courses.map((course) => course.code));
        const result = await db.rpc("import_timetable", {
            p_university: university,
            p_payload: {
                scope: codes.map((subject) => ({ term, subject })),
                subjects: codes.map((code) => scraped.get(code)).filter(Boolean),
                courses,
                sections: timetable.sections.filter((section) => section.term === term && courseCodes.has(section.course)),
            },
        });
        // Only new or changed sections are written; the rest are left alone.
        const changed = result.changed ?? result.sections;
        totals.sections += result.sections;
        totals.changed += changed;
        totals.deleted += result.deleted;
        log(`Saved ${term} ${codes[0]}-${codes.at(-1)}: ${result.sections} sections (${changed} new or changed), ${result.deleted} removed`);
    }

    await db.rpc("list_terms", { p_university: university, p_codes: listedCodes });
    log(
        `Timetable saved: ${totals.sections} sections (${totals.changed} new or changed), ${totals.deleted} removed; listed ${listedCodes.join(", ")}`,
    );
}

/** Groups whole term/subject scopes, targeting SECTIONS_PER_IMPORT sections per import. */
function importChunks(subjectCodes, timetable) {
    const subjectOf = new Map(timetable.courses.map((course) => [course.code, course.subject_code]));
    const termCounts = new Map(timetable.terms.map(({ code }) => [code, new Map()]));
    for (const section of timetable.sections) {
        const subject = subjectOf.get(section.course);
        const counts = termCounts.get(section.term);
        if (counts) counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }

    const chunks = [];
    for (const [term, counts] of termCounts) {
        let current = [];
        let sections = 0;
        for (const code of subjectCodes) {
            const count = counts.get(code) ?? 0;
            if (current.length && (current.length === SUBJECTS_PER_IMPORT || sections + count > SECTIONS_PER_IMPORT)) {
                chunks.push({ term, codes: current });
                current = [];
                sections = 0;
            }
            current.push(code);
            sections += count;
        }
        if (current.length) chunks.push({ term, codes: current });
    }
    return chunks;
}

/** Replaces each scraped term's final exams, converting their campus times to UTC. */
async function importExams(db, university, timetable) {
    if (!timetable.exams?.length) return;
    const [{ timezone }] = await db.selectAll("universities", "timezone", { id: `eq.${university}` });
    const utc = (local) => (local ? zonedToUtc(local, timezone) : null);
    for (const { code } of timetable.terms) {
        const exams = timetable.exams
            .filter((exam) => exam.term === code)
            .map((exam) => ({ ...exam, starts_at: utc(exam.starts_at), ends_at: utc(exam.ends_at) }));
        const saved = await db.rpc("import_exams", { p_university: university, p_term: code, p_exams: exams });
        log(`Saved ${saved} exams for ${code}`);
    }
}

/** @returns {Promise<string[]>} Warnings about what came back. */
export async function importDetails(db, university, scraper, timetable, mode) {
    if (mode === "none") return [];
    if (!scraper.scrapeCourseDetails) {
        log("This university's scraper doesn't read course details");
        return [];
    }

    const stored = await db.selectAll("courses", "code,description", { university_id: `eq.${university}` }, "code");
    const knownCodes = new Set(stored.map((course) => course.code));
    const withDescription = new Set(stored.filter((course) => course.description).map((course) => course.code));
    const courses = timetable.courses.filter((course) => mode === "all" || !withDescription.has(course.code));
    log(`Fetching details for ${courses.length} courses`);

    let saved = 0;
    for await (const batch of scraper.scrapeCourseDetails(courses, knownCodes)) {
        saved += await db.rpc("import_course_details", { p_university: university, p_courses: batch });
    }
    log(`Saved details for ${saved} courses`);
    // With "missing", the courses fetched are the ones that had no description last time, which for
    // most of them is because the calendar has none, so finding none again says nothing.
    return mode === "all" && courses.length >= DETAILS_SAMPLE && saved === 0
        ? [`Fetched details for ${courses.length} courses and none had a description`]
        : [];
}

/** Scrapes and checks like a real run, saving nothing. Exits non-zero when a check fails. */
async function dryRun(db, scraper, { university, details }) {
    log("Dry run: nothing is saved");
    const timetable = await scraper.scrapeTimetable();
    const { failures, warnings } = await check(db, university, measure(timetable));
    log(`${timetable.exams?.length ?? 0} exams`);

    if (details !== "none" && scraper.scrapeCourseDetails && timetable.courses.length) {
        // Spread across the catalogue rather than the first subject's courses.
        const step = Math.max(1, Math.floor(timetable.courses.length / DETAILS_SAMPLE));
        const sample = timetable.courses.filter((_, index) => index % step === 0).slice(0, DETAILS_SAMPLE);
        const knownCodes = new Set(timetable.courses.map((course) => course.code));
        let found = 0;
        for await (const batch of scraper.scrapeCourseDetails(sample, knownCodes)) found += batch.length;
        log(`Course details: ${found} of ${sample.length} sampled courses have a description`);
        if (found === 0) failures.push(`None of ${sample.length} sampled courses came back with a description`);
    }

    if (failures.length) throw new Error(`Dry run failed: ${failures.join("; ")}`);
    log(warnings.length ? `Dry run passed with ${warnings.length} warnings` : "Dry run passed");
}

/** The metrics of the last run that saved, which this one is compared with. */
async function lastSavedMetrics(db, university) {
    try {
        const [run] = await db.select(
            "refresh_runs",
            "metrics",
            { university_id: `eq.${university}`, status: "in.(ok,warning)" },
            { order: "started_at.desc", limit: 1 },
        );
        return run?.metrics ?? null;
    } catch (error) {
        log(`Couldn't read earlier runs: ${error.message}`);
        return null;
    }
}

// Recording a run never fails the refresh: fresh data matters more than the log of it.
async function startRun(db, university) {
    try {
        const run = await db.insert("refresh_runs", { university_id: university });
        return run.id;
    } catch (error) {
        log(`Couldn't record the run: ${error.message}`);
        return null;
    }
}

async function finishRun(db, id, values) {
    if (id === null) return;
    try {
        await db.update("refresh_runs", { id: `eq.${id}` }, { ...values, finished_at: new Date().toISOString() });
    } catch (error) {
        log(`Couldn't record how the run went: ${error.message}`);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const { university } = options;
    const scraper = await import(`./universities/${university}.js`);
    const db = connect({ readOnly: options.dryRun });
    if (options.dryRun) return dryRun(db, scraper, options);

    const runId = await startRun(db, university);
    let metrics = null;
    try {
        const timetable = await scraper.scrapeTimetable().catch((error) => {
            throw isUnreachable(error) ? new UnreachableError(error) : error;
        });
        metrics = measure(timetable);
        const { failures, warnings } = await check(db, university, metrics);
        if (failures.length && !options.force) throw new HealthError(failures);
        if (failures.length) log("Saving anyway (--force)");

        await importTimetable(db, university, timetable);
        await importExams(db, university, timetable);
        const problems = [
            ...failures.map((failure) => `Saved with --force: ${failure}`),
            ...warnings,
            ...(await importDetails(db, university, scraper, timetable, options.details)),
        ];
        await finishRun(db, runId, { status: problems.length ? "warning" : "ok", problems, metrics });
    } catch (error) {
        const expected = error instanceof HealthError || error instanceof UnreachableError;
        await finishRun(db, runId, {
            status: error instanceof UnreachableError ? "unreachable" : "failed",
            problems: error.problems ?? [],
            error: (expected ? error.message : String(error.stack ?? error)).slice(0, 4000),
            metrics,
        });
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        if (error instanceof UnreachableError) {
            // An annotation on the run in GitHub Actions, rather than a failed job.
            console.log(`${process.env.GITHUB_ACTIONS ? "::warning::" : ""}${error.message}`);
            return;
        }
        console.error(error);
        process.exit(1);
    });
}
