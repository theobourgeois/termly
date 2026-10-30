/**
 * Ellucian Banner 9 Self-Service (StudentRegistrationSsb) class search, which answers without signing
 * in at most universities that run it. One university's scraper configures this with its address and
 * whatever it does differently; see universities/smu.js.
 *
 * The search returns sections; meetings, instructors and final exams come from one request per section.
 */
import { decodeHTML } from "entities";
import { httpError, log } from "./import.js";

const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const PAGE_SIZE = 500;
const CONCURRENCY = 4;
const REQUEST_DELAY_MS = 120;

/** Banner sends text HTML-encoded: "Theol &amp; Rel Studies", "Bront&euml;". */
export const decode = (text) =>
    decodeHTML(String(text ?? ""))
        .replace(/\s+/g, " ")
        .trim();

/** "ED-D" -> "EDD": course codes are letters and digits only. */
const codePart = (text) =>
    String(text ?? "")
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase();

/** Text a timetable puts where nothing is set ("None specified", "TBA"). */
const isBlank = (text) => !text || /^(none|none specified|tba|tbd|to be announced)$/i.test(text);
/** Buildings that stand for "somewhere off campus" ("Off Campus", "Off-Campus Locations"), not a room. */
const isOffCampus = (building) => /^off[- ]?campus/i.test(building);
/** How an online meeting is described: its delivery method when that says how ("Online Synchronous"). */
const onlineLabel = (method) => (/online|remote|virtual|distance|web|sync|stream/i.test(method) ? method : "Online");

/** A Banner session: the cookies its class search keeps the chosen term in. */
async function openSession(base) {
    const cookies = new Map();
    const keep = (response) => {
        for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(";");
            const [name, ...value] = pair.split("=");
            cookies.set(name.trim(), value.join("="));
        }
    };
    const request = async (path, { method = "GET", form, raw = false, attempts = 3 } = {}) => {
        for (let attempt = 1; ; attempt++) {
            try {
                const response = await fetch(`${base}/${path}`, {
                    method,
                    headers: {
                        "user-agent": USER_AGENT,
                        accept: "application/json, text/javascript, */*",
                        "x-requested-with": "XMLHttpRequest",
                        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
                        ...(form ? { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
                    },
                    body: form ? new URLSearchParams(form).toString() : undefined,
                });
                keep(response);
                if (!response.ok) throw httpError(response);
                const text = await response.text();
                if (raw) return text;
                return text ? JSON.parse(text) : null;
            } catch (error) {
                if (attempt >= attempts) throw new Error(`${path.split("?")[0]}: ${error.message}`, { cause: error });
                await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
            }
        }
    };
    await request("term/termSelection?mode=search").catch(() => null);
    return request;
}

const uniqueSessionId = () => `ds${Math.random().toString(36).slice(2, 12)}`;

/** Every section in a term. A fresh session per term, since Banner keeps the chosen term in the session. */
async function searchTerm(base, term, pageSize = PAGE_SIZE) {
    const request = await openSession(base);
    const session = uniqueSessionId();
    await request("term/search?mode=search", {
        method: "POST",
        form: {
            term,
            studyPath: "",
            studyPathText: "",
            startDatepicker: "",
            endDatepicker: "",
            uniqueSessionId: session,
        },
    });
    const sections = [];
    for (let offset = 0; ; offset += pageSize) {
        const params = new URLSearchParams({
            txt_term: term,
            startDatepicker: "",
            endDatepicker: "",
            uniqueSessionId: session,
            pageOffset: String(offset),
            pageMaxSize: String(pageSize),
            sortColumn: "subjectDescription",
            sortDirection: "asc",
        });
        const page = await request(`searchResults/searchResults?${params}`);
        if (!page?.success) throw new Error(`Search failed for ${term}`);
        sections.push(...(page.data ?? []));
        if (sections.length >= (page.totalCount ?? 0) || !page.data?.length) break;
    }
    const subjects = await request(`classSearch/get_subject?searchTerm=&term=${term}&offset=1&max=1000`);
    return { request, sections, subjects: subjects ?? [] };
}

/** Runs `task` over `items` a few at a time, pausing between batches. */
async function inBatches(items, task, onProgress) {
    const results = [];
    for (let start = 0; start < items.length; start += CONCURRENCY) {
        results.push(...(await Promise.all(items.slice(start, start + CONCURRENCY).map(task))));
        onProgress?.(Math.min(start + CONCURRENCY, items.length));
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
    return results;
}

/** "09/09/2026" -> "2026-09-09". */
const isoDate = (text) => {
    const match = String(text ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
};
/** "1430" -> "14:30". */
const clock = (text) => (/^\d{4}$/.test(text ?? "") ? `${text.slice(0, 2)}:${text.slice(2)}` : null);
/** Some timetables write "no set time" as 00:00-00:01. */
const isPlaceholderTime = (meeting) => meeting.beginTime === "0000" && ["0001", "0000"].includes(meeting.endTime);

const dayColumns = [
    ["monday", "M"],
    ["tuesday", "T"],
    ["wednesday", "W"],
    ["thursday", "R"],
    ["friday", "F"],
    ["saturday", "S"],
    ["sunday", "U"],
];

// Order matters: "Lecture and Lab Combined" is a lecture, "Honours Research" a thesis.
const kinds = [
    [/lecture\s*(\/|and)\s*lab|class\s*\/\s*lab|combined/i, "Lec", "lecture"],
    [/world wide web|fully online|blended|distance/i, "Lec", "lecture"],
    [/lab/i, "Lab", "lab"],
    [/problem session|peer led/i, "Tut", "tutorial"],
    [/self instruction|supervised study|self study|self paced/i, "Ind", "independent_study"],
    [/honours essay|dissertation|research|masters project/i, "Ths", "thesis"],
    [/work period/i, "WkT", "work_term"],
    [/tutorial|recitation/i, "Tut", "tutorial"],
    [/seminar/i, "Sem", "seminar"],
    [/studio/i, "Std", "studio"],
    [/thesis/i, "Ths", "thesis"],
    [/practicum|placement|clinical/i, "Prac", "clinical"],
    [/co-?op|work term/i, "WkT", "work_term"],
    [/internship/i, "Int", "internship"],
    [/field/i, "Fld", "field"],
    [/directed|independent|reading/i, "Ind", "independent_study"],
    [/non.?course/i, "Other", "other"],
    [/lecture|class/i, "Lec", "lecture"],
];

/** Banner's schedule type ("Lecture", "AST Lecture", "Recitation") as a short label and a shared kind. */
function classify(description) {
    const match = kinds.find(([pattern]) => pattern.test(description ?? ""));
    return match ? { type: match[1], kind: match[2] } : { type: decode(description) || "Other", kind: "other" };
}

/** "Dr Paul Muir" -> "Paul Muir"; "Muir, Paul" -> "Paul Muir". */
const cleanName = (name) =>
    decode(name)
        .replace(/^([^,]+),\s*([^,]+)$/, "$2 $1")
        .replace(/^(dr|prof|professor|mr|mrs|ms|mx)\.?\s+/i, "")
        .trim();

function mostCommon(values) {
    const counts = new Map();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/**
 * @param {object} config
 * @param {string} config.baseUrl ".../StudentRegistrationSsb/ssb"
 * @param {number} [config.recentTerms] How many of the newest terms to look at (default 6).
 * @param {number} [config.pageSize] Sections per search page (default 500). Some servers (UNBC) fail on
 *   pages that big.
 * @param {number} [config.keepEndedDays] Keep a term this many days after it ends (default 120).
 * @param {(term: {code: string, description: string, starts_on: string, ends_on: string}) => {name: string, season: string, year: number}} config.describeTerm
 * @param {(listing: {code: string, description: string}) => string | null} [config.roughEnd] When the term ends
 *   ("2026-04-30"), from its name, so finished terms are skipped before their sections are read.
 * @param {(meeting: object, section: object) => boolean} [config.isOnline]
 * @param {"classSearch" | "courseSearch"} [config.termsFrom] Where to list terms. Some universities (Yukon)
 *   drop a term from the class search once registration closes; the course search still has it.
 * @param {(listing: {code: string, description: string}) => boolean} [config.includeTerm] Skip terms
 *   that aren't regular ones (continuing studies, open learning).
 * @param {(title: string) => string} [config.cleanTitle] Tidy course titles ("Torts (3,0,0)" -> "Torts").
 * @returns {{scrapeTimetable: () => Promise<import("./import.js").Timetable>, scrapeCourseDetails: Function}}
 */
export function banner9({
    baseUrl,
    recentTerms = 6,
    pageSize = PAGE_SIZE,
    keepEndedDays = 120,
    termsFrom = "classSearch",
    includeTerm,
    describeTerm,
    roughEnd,
    isOnline,
    cleanTitle = (title) => title,
}) {
    /** A section of each course, for reading its description after the timetable. */
    const sectionOf = new Map();
    /** Subject names to codes, for prerequisite tables that name subjects ("Computer Science 115"). */
    const subjectCodes = new Map();

    async function scrapeTimetable() {
        const request = await openSession(baseUrl);
        const listed = (await request(`${termsFrom}/getTerms?searchTerm=&offset=1&max=${recentTerms}`)) ?? [];
        log(`Newest terms: ${listed.map((term) => `${term.code} (${decode(term.description)})`).join(", ")}`);
        const cutoff = new Date(Date.now() - keepEndedDays * 86_400_000).toISOString().slice(0, 10);

        const terms = [];
        const sections = [];
        const exams = [];
        const subjects = new Map();
        const courses = new Map();
        const failedSubjects = new Set();

        for (const listing of listed) {
            const named = {
                code: listing.code,
                description: decode(listing.description).replace(/\s*\(View Only\)\s*/i, ""),
            };
            if (includeTerm && !includeTerm(named)) {
                log(`${listing.code} (${named.description}) isn't a regular term, skipping`);
                continue;
            }
            const roughlyEnds = roughEnd?.(named);
            if (roughlyEnds && roughlyEnds < cutoff) {
                log(`${listing.code} (${decode(listing.description)}) is over, skipping`);
                continue;
            }
            const {
                request: termRequest,
                sections: found,
                subjects: termSubjects,
            } = await searchTerm(baseUrl, listing.code, pageSize);
            if (found.length === 0) {
                log(`${listing.code}: no sections`);
                continue;
            }
            for (const subject of termSubjects) {
                const code = codePart(subject.code);
                subjects.set(code, { code, name: decode(subject.description) });
                subjectCodes.set(decode(subject.description).toLowerCase(), code);
            }

            const details = await inBatches(
                found,
                async (section) => {
                    try {
                        const meetings = await termRequest(
                            `searchResults/getFacultyMeetingTimes?term=${listing.code}&courseReferenceNumber=${section.courseReferenceNumber}`,
                        );
                        return { section, meetings: meetings?.fmt ?? [] };
                    } catch (error) {
                        failedSubjects.add(section.subject);
                        log(
                            `${listing.code} ${section.subject}${section.courseNumber}-${section.sequenceNumber}: ${error.message}`,
                        );
                        return { section, meetings: null };
                    }
                },
                (done) => {
                    if (done % 200 < CONCURRENCY) log(`[${listing.code}] ${done}/${found.length} sections`);
                },
            );

            const termSections = [];
            for (const { section, meetings } of details) {
                if (meetings === null) continue;
                const subjectCode = codePart(section.subject);
                const code = `${subjectCode}${codePart(section.courseNumber)}`;
                if (!/^[A-Z0-9]{2,20}$/.test(code) || !subjectCode) continue;
                const credits = section.creditHours ?? section.creditHourLow ?? section.creditHourHigh ?? null;
                const existing = courses.get(code);
                courses.set(code, {
                    code,
                    subject_code: subjectCode,
                    number: codePart(section.courseNumber),
                    title: existing?.title ?? (cleanTitle(decode(section.courseTitle)) || code),
                    credits: Math.max(existing?.credits ?? 0, credits ?? 0),
                });
                if (!subjects.has(subjectCode)) {
                    subjects.set(subjectCode, { code: subjectCode, name: decode(section.subjectDescription) });
                }

                const isExamMeeting = (entry) => /exam/i.test(entry.meetingTime.meetingTypeDescription ?? "");
                const withTimes = meetings.filter((entry) => entry.meetingTime);
                const classes = withTimes.filter((entry) => !isExamMeeting(entry));
                const people = new Map();
                for (const entry of meetings) {
                    for (const person of entry.faculty ?? []) {
                        const name = cleanName(person.displayName);
                        if (name) people.set(name, (people.get(name) ?? false) || Boolean(person.primaryIndicator));
                    }
                }
                const dates = classes.map((entry) => [
                    isoDate(entry.meetingTime.startDate),
                    isoDate(entry.meetingTime.endDate),
                ]);
                const startsOn =
                    dates
                        .map(([start]) => start)
                        .filter(Boolean)
                        .sort()[0] ?? null;
                const endsOn =
                    dates
                        .map(([, end]) => end)
                        .filter(Boolean)
                        .sort()
                        .at(-1) ?? null;

                if (!sectionOf.has(code))
                    sectionOf.set(code, { term: listing.code, crn: String(section.courseReferenceNumber) });
                termSections.push({
                    term: listing.code,
                    crn: String(section.courseReferenceNumber),
                    course: code,
                    section: String(section.sequenceNumber ?? "").trim() || "-",
                    ...classify(section.scheduleTypeDescription),
                    credits,
                    capacity: section.maximumEnrollment ?? null,
                    enrolled: section.enrollment ?? null,
                    waitlist: section.waitCount ?? null,
                    starts_on: startsOn,
                    ends_on: endsOn && startsOn && endsOn < startsOn ? startsOn : endsOn,
                    link_code: section.linkIdentifier ?? null,
                    cross_listed_codes: [],
                    notes: null,
                    meetings: classes.map(({ meetingTime: meeting }) => {
                        const start = clock(meeting.beginTime);
                        const end = clock(meeting.endTime);
                        const timed = start && end && end > start && !isPlaceholderTime(meeting);
                        const online = isOnline?.(meeting, section) ?? !meeting.building;
                        const building = isBlank(decode(meeting.buildingDescription))
                            ? ""
                            : decode(meeting.buildingDescription);
                        const room = isBlank(decode(meeting.room)) ? "" : decode(meeting.room);
                        return {
                            days: dayColumns.filter(([column]) => meeting[column]).map(([, day]) => day),
                            start_time: timed ? start : null,
                            end_time: timed ? end : null,
                            location: online
                                ? onlineLabel(decode(section.instructionalMethodDescription))
                                : isOffCampus(building)
                                  ? "Off campus"
                                  : [building, room].filter(Boolean).join(" ") || null,
                            rooms:
                                online || !building || isOffCampus(building)
                                    ? []
                                    : [
                                          {
                                              campus: decode(meeting.campusDescription) || null,
                                              building,
                                              room: room || null,
                                          },
                                      ],
                            starts_on: isoDate(meeting.startDate),
                            ends_on: isoDate(meeting.endDate),
                        };
                    }),
                    instructors: [...people]
                        .sort((a, b) => Number(b[1]) - Number(a[1]))
                        .map(([name, is_primary]) => ({ name, is_primary })),
                });

                for (const { meetingTime: exam } of withTimes.filter(isExamMeeting)) {
                    const day = isoDate(exam.startDate);
                    const start = clock(exam.beginTime);
                    if (!day || !start) continue;
                    const end = clock(exam.endTime);
                    exams.push({
                        term: listing.code,
                        course: code,
                        section: String(section.sequenceNumber ?? "").trim(),
                        starts_at: `${day}T${start}`,
                        ends_at: end && end > start ? `${day}T${end}` : null,
                        location:
                            [decode(exam.buildingDescription), decode(exam.room)].filter(Boolean).join(" ") || null,
                    });
                }
            }

            const termStart = mostCommon(termSections.map((section) => section.starts_on));
            const termEnd = mostCommon(termSections.map((section) => section.ends_on));
            if (!termStart || !termEnd) {
                log(`${listing.code}: no dated sections, skipping`);
                continue;
            }
            if (termEnd < cutoff) {
                log(`${listing.code} ended ${termEnd}, skipping`);
                continue;
            }
            const description = named.description;
            // describeTerm may also return its own starts_on/ends_on.
            terms.push({
                code: listing.code,
                starts_on: termStart,
                ends_on: termEnd < termStart ? termStart : termEnd,
                ...describeTerm({ code: listing.code, description, starts_on: termStart, ends_on: termEnd }),
            });
            sections.push(...termSections);
            log(
                `${listing.code} (${description}): ${termSections.length} sections, ${exams.filter((exam) => exam.term === listing.code).length} exams`,
            );
        }

        const kept = new Set(terms.map((term) => term.code));
        const keptSections = sections.filter((section) => kept.has(section.term));
        const usedCourses = new Set(keptSections.map((section) => section.course));
        return {
            terms,
            subjects: [...subjects.values()].filter((subject) => /^[A-Z0-9]{1,10}$/.test(subject.code)),
            courses: [...courses.values()].filter((course) => usedCourses.has(course.code)),
            sections: keptSections,
            exams: exams.filter((exam) => kept.has(exam.term) && usedCourses.has(exam.course)),
            failedSubjects: [...failedSubjects],
        };
    }

    /**
     * Descriptions from Banner's own catalog text, one request per course (through one of its sections).
     * A "Prerequisite: ..." sentence in it becomes the requisites.
     * @returns {AsyncGenerator<import("./import.js").CourseDetails[]>}
     */
    async function* scrapeCourseDetails(courses, knownCodes, batchSize = 100) {
        const request = await openSession(baseUrl);
        let batch = [];
        let missing = 0;
        const wanted = courses.filter((course) => sectionOf.has(course.code));
        for (let start = 0; start < wanted.length; start += CONCURRENCY) {
            const details = await Promise.all(
                wanted.slice(start, start + CONCURRENCY).map(async (course) => {
                    const { term, crn } = sectionOf.get(course.code);
                    try {
                        const html = await rawPost(request, "searchResults/getCourseDescription", {
                            term,
                            courseReferenceNumber: crn,
                        });
                        const detail = readDescription(course.code, html, knownCodes);
                        if (!detail.requisites_text) {
                            const table = await rawPost(request, "searchResults/getSectionPrerequisites", {
                                term,
                                courseReferenceNumber: crn,
                            });
                            Object.assign(detail, readPrerequisiteTable(course.code, table, knownCodes, subjectCodes));
                        }
                        return detail;
                    } catch (error) {
                        log(`${course.code}: ${error.message}`);
                        return null;
                    }
                }),
            );
            for (const detail of details) {
                if (detail?.description) batch.push(detail);
                else missing++;
            }
            if (batch.length >= batchSize) {
                log(`[${Math.min(start + CONCURRENCY, wanted.length)}/${wanted.length}] course details`);
                yield batch;
                batch = [];
            }
            await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
        }
        if (batch.length) yield batch;
        log(`Course details done; ${missing + courses.length - wanted.length} of ${courses.length} had no description`);
    }

    return { scrapeTimetable, scrapeCourseDetails };
}

/** POSTs a form and returns the raw text: Banner's description endpoints answer with HTML. */
async function rawPost(request, path, form) {
    return request(path, { method: "POST", form, raw: true });
}

// "Prerequisite:", "Co-requisite:", and MUN's short "PR:", "CO:", "CR:".
const REQUISITE_WORDS = "[Pp]re-?[Rr]equisites?|[Cc]o-?[Rr]equisites?|[Ee]xclusions?|[Rr]estrictions?|PR|CO|CR";
const REQUISITE_LABEL = new RegExp(`\\b(${REQUISITE_WORDS})\\s*:`);
const requisiteKind = (label) =>
    /^co/i.test(label) ? "corequisite" : /^(exclusion|cr$)/i.test(label) ? "exclusion" : "prerequisite";

/** Course codes in requisite text: "CSCI 1226 or 1227" -> CSCI1226, CSCI1227; a bare number keeps the last subject. */
function codesIn(text, knownCodes, ownCode) {
    const codes = [];
    let subject = null;
    for (const [, letters, number] of text.toUpperCase().matchAll(/\b(?:([A-Z]{2,5})[\s-]*)?(\d{3,4}[A-Z]?)\b/g)) {
        subject = letters ?? subject;
        const code = subject ? `${subject}${number}` : null;
        if (code && code !== ownCode && knownCodes.has(code)) codes.push(code);
    }
    return codes;
}

/**
 * Banner's description HTML: the course text, with requisites pulled out. Everything from the first
 * requisite label on is requisites, since they can hold periods ("(min. D)").
 */
function readDescription(code, html, knownCodes) {
    const text = decode(
        String(html ?? "")
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, " "),
    );
    const empty = { code, description: null, requisites_text: null, requisites: [] };
    if (!text || /no course description|for a description of this course/i.test(text)) return empty;
    const labelAt = text.search(REQUISITE_LABEL);
    const description = (labelAt >= 0 ? text.slice(0, labelAt) : text)
        .replace(/^section information text:\s*/i, "")
        // MUN repeats the code and title: "NURS 2100 - Indigenous Health - examines ..."
        .replace(/^[A-Z]{2,5}\s*\d{3,4}[A-Z]?\s+-\s+.*?\s*-\s+(\w)/, (_, first) => first.toUpperCase())
        .trim();
    const requisitesText = labelAt >= 0 ? text.slice(labelAt).trim() : "";
    const requisites = [];
    for (const part of requisitesText.split(new RegExp(`(?=\\b(?:${REQUISITE_WORDS})\\s*:)`))) {
        const label = part.match(REQUISITE_LABEL)?.[1] ?? "";
        for (const required of codesIn(part.replace(REQUISITE_LABEL, ""), knownCodes, code)) {
            requisites.push({ code: required, kind: requisiteKind(label) });
        }
    }
    return {
        code,
        // A few words is just the title again, not a description.
        description: description.split(/\s+/).length >= 4 ? description : null,
        requisites_text: requisitesText || null,
        requisites: [
            ...new Map(requisites.map((requisite) => [`${requisite.kind} ${requisite.code}`, requisite])).values(),
        ],
    };
}

/**
 * Banner's prerequisite table (And/Or, Subject, Course Number, Level, Grade), where the description has
 * none. Subjects come as names ("Computer Science"), so they're mapped back to codes.
 */
function readPrerequisiteTable(code, html, knownCodes, subjectCodes) {
    const rows = [...String(html ?? "").matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)].map(([, row]) =>
        [...row.matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gis)].map(([, cell]) => decode(cell.replace(/<[^>]+>/g, " "))),
    );
    const header = rows.find((cells) => cells.some((cell) => /^subject$/i.test(cell)));
    if (!header) return readAreaPrerequisites(code, html, knownCodes, subjectCodes);
    const column = (name) => header.findIndex((cell) => cell.toLowerCase() === name);
    const [andOr, subjectAt, numberAt] = [column("and/or"), column("subject"), column("course number")];
    const parts = [];
    const requisites = [];
    for (const cells of rows.slice(rows.indexOf(header) + 1)) {
        const subject = cells[subjectAt];
        const number = codePart(cells[numberAt]);
        if (!subject || !number) continue;
        const open = cells.includes("(") ? "(" : "";
        const close = cells.includes(")") ? ")" : "";
        parts.push(`${cells[andOr] ? `${cells[andOr].toLowerCase()} ` : ""}${open}${subject} ${number}${close}`);
        const subjectCode = subjectCodes.get(subject.toLowerCase());
        if (subjectCode && knownCodes.has(`${subjectCode}${number}`) && `${subjectCode}${number}` !== code) {
            requisites.push({ code: `${subjectCode}${number}`, kind: "prerequisite" });
        }
    }
    if (parts.length === 0) return {};
    return {
        requisites_text: `Prerequisites: ${parts.join(" ")}`,
        requisites: [...new Map(requisites.map((requisite) => [requisite.code, requisite])).values()],
    };
}

/**
 * Newer Banner's "Area Prerequisites" (USask): groups of "( Course or Test: Chemistry 111 Required
 * Credits: 3.0 May not be taken concurrently. )" joined by "or" and "and".
 */
function readAreaPrerequisites(code, html, knownCodes, subjectCodes) {
    const text = decode(String(html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    const items = [...text.matchAll(/\(\s*Course or Test:\s*(.+?)\s+(?:Required|Minimum|May|\))(.*?)\)\s*(and|or)?/gi)];
    if (items.length === 0) return {};
    const parts = [];
    const requisites = [];
    for (const [, name, rest, joiner] of items) {
        const concurrent = /may be taken concurrently/i.test(rest);
        parts.push(
            `${name}${concurrent ? " (may be taken concurrently)" : ""}${joiner ? ` ${joiner.toLowerCase()}` : ""}`,
        );
        const match = name.match(/^(.*?)\s+([A-Z]*\d+[A-Z]*)$/i);
        const subjectCode = match && subjectCodes.get(match[1].toLowerCase());
        const required = subjectCode && `${subjectCode}${codePart(match[2])}`;
        if (required && required !== code && knownCodes.has(required)) {
            requisites.push({ code: required, kind: concurrent ? "corequisite" : "prerequisite" });
        }
    }
    return {
        requisites_text: `Prerequisites: ${parts.join(" ")}`,
        requisites: [...new Map(requisites.map((requisite) => [requisite.code, requisite])).values()],
    };
}
