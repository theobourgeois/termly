import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { cache } from "react";
import { CATALOG_SOURCES, catalogFileName } from "./catalog-sources.mjs";
import { days as appDays, type Term } from "./constants";
import type { ExamSchedule } from "./exams";
import { summarizeRating, type RatingSummary } from "./instructors";
import { courseKey, sessionTypeOrder } from "./schedule";
import { publicClient } from "./supabase/public";
import { currentTermCode, dateIn, listedCodes, termIndex, type TermInfo } from "./terms";
import { getUniversity, universities } from "./university";
import type {
    ClassSession,
    Course,
    CourseAndSubjectCode,
    CourseCode,
    CourseListItem,
    CourseSummary,
    Day,
    Enrollment,
    InstructorListItem,
    InstructorRating,
    Room,
    Subject,
    SubjectCode,
    Time,
} from "./types";

/**
 * Server-only access to the course catalog in Supabase. The whole catalog for the university is read
 * at once (a few thousand courses), kept in memory for a few minutes, and pages pick what they need.
 * Client components receive trimmed props (CourseSummary, CourseListItem) rather than importing this.
 */

const PAGE_SIZE = 1000;
const READ_ATTEMPTS = 3;
const FRESH_FOR_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
/** A meeting this short is a one-off (a makeup class, a room change for a day), not the weekly pattern. */
const MIN_RECURRING_DAYS = 14;

type MeetingRow = {
    days: string[];
    start_time: string | null;
    end_time: string | null;
    location: string | null;
    starts_on: string | null;
    ends_on: string | null;
    /** Room ids. */
    rooms: string[];
};

type SectionRow = {
    term: Term;
    course: string;
    crn: string;
    section: string;
    type: string;
    kind: string;
    capacity: number | null;
    enrolled: number | null;
    meetings: MeetingRow[];
    instructors: { name: string; is_primary: boolean }[];
};

type CourseRow = {
    code: string;
    subject_code: string;
    number: string;
    title: string;
    credits: number | null;
    description: string | null;
};

/** A university's catalog as stored: what's read from Supabase or from its catalog file. */
type CatalogRows = {
    terms: { code: string; name: string; starts_on: string; ends_on: string; is_listed: boolean }[];
    subjects: Subject[];
    courses: CourseRow[];
    sections: SectionRow[];
    prerequisites: { course: string; required: string }[];
    ratings: {
        match_name: string;
        first_name: string;
        last_name: string;
        profile_url: string | null;
        rating: number | null;
        difficulty: number | null;
        would_take_again: number | null;
        rating_count: number;
    }[];
    exams: {
        term: Term;
        course: string;
        section: string;
        starts_at: string;
        ends_at: string | null;
        location: string | null;
    }[];
    rooms: { id: string; campus: string | null; building: string; name: string }[];
};

type Catalog = {
    terms: TermInfo[];
    /** Listed term codes, oldest first. */
    listed: Term[];
    subjects: Subject[];
    courses: Course[];
    byCode: Map<string, Course>;
    ratings: Map<string, InstructorRating>;
    exams: ExamSchedule;
    rooms: Map<string, Room>;
    /** Per term, each room's sessions. */
    roomSessions: Map<Term, Map<string, ClassSession[]>>;
    derived: Map<string, unknown>;
    /** Read from this deployment's file, which can't change, so it never needs reading again. */
    fromFile: boolean;
};

/** A session and the rooms it's held in. */
type PlacedSession = { session: ClassSession; rooms: Set<string> };

type Db = ReturnType<typeof publicClient>;

/**
 * Every row of one university's table or view. The first page also returns the row count, then the
 * rest are read in parallel. Pages are as big as the API actually returned, so a project that caps
 * rows per request lower than asked still reads everything.
 */
async function readAll<T>(
    db: Db,
    source: string,
    columns: string,
    university: string,
    order: string[],
    filters: Record<string, string> = {},
): Promise<T[]> {
    const page = async (from: number, to: number, count: boolean) => {
        // A busy database cancels slow reads (a statement timeout), so each page gets a few tries.
        for (let attempt = 1; ; attempt++) {
            let query = db
                .from(source)
                .select(columns, count ? { count: "exact" } : undefined)
                .eq("university_id", university);
            for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
            for (const column of order) query = query.order(column);
            const result = await query.range(from, to);
            if (!result.error || attempt >= READ_ATTEMPTS) return result;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    };
    const first = await page(0, PAGE_SIZE - 1, true);
    if (first.error) throw new Error(`${source}: ${first.error.message}`);
    const rows = (first.data ?? []) as T[];
    const size = rows.length;
    const total = first.count ?? size;
    if (size === 0 || total <= size) return rows;

    const starts = Array.from({ length: Math.ceil((total - size) / size) }, (_, index) => size * (index + 1));
    const pages = await Promise.all(starts.map((from) => page(from, from + size - 1, false)));
    for (const { data, error } of pages) {
        if (error) throw new Error(`${source}: ${error.message}`);
        rows.push(...((data ?? []) as T[]));
    }
    return rows;
}

/** Runs a Supabase read, trying again when it fails: a busy database cancels slow reads. */
async function retried<T>(source: string, read: () => PromiseLike<{ data: T; error: { message: string } | null }>) {
    for (let attempt = 1; ; attempt++) {
        const { data, error } = await read();
        if (!error) return data;
        if (attempt >= READ_ATTEMPTS) throw new Error(`${source}: ${error.message || "read failed"}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
}

/**
 * Like readAll, for a view that builds JSON per row (catalog_sections). Paging it with offsets builds
 * every skipped row again, so later pages get slower until the database cancels them. Instead the
 * ids where each page starts are found first (cheap: no JSON), then the pages are read by id range.
 */
async function readAllById<T>(db: Db, source: string, columns: string, university: string): Promise<T[]> {
    const { count } = await retried(source, async () => {
        const { count, error } = await db
            .from(source)
            .select("id", { count: "exact", head: true })
            .eq("university_id", university);
        return { data: { count }, error };
    });
    // Pages a little under the API's 1,000-row cap, so rows added between these reads still fit.
    const size = PAGE_SIZE - 100;
    const pages = Math.ceil((count ?? 0) / size);
    if (pages === 0) return [];

    const starts = await Promise.all(
        Array.from({ length: pages - 1 }, async (_, index) => {
            const at = (index + 1) * size;
            const row = await retried(source, () =>
                db
                    .from(source)
                    .select("id")
                    .eq("university_id", university)
                    .order("id")
                    .range(at, at)
                    .single<{ id: string }>(),
            );
            return (row as { id: string }).id;
        }),
    );
    const results = await Promise.all(
        [null, ...starts].map((from, index) =>
            retried(source, () => {
                let query = db.from(source).select(columns).eq("university_id", university);
                if (from) query = query.gte("id", from);
                if (index < starts.length) query = query.lt("id", starts[index]);
                return query.order("id").returns<T[]>();
            }),
        ),
    );
    return results.flatMap((rows) => rows ?? []);
}

/** "08:35:00" -> "0835". */
const toTime = (time: string) => time.slice(0, 2) + time.slice(3, 5);

const spanDays = (meeting: MeetingRow) =>
    meeting.starts_on && meeting.ends_on
        ? (Date.parse(meeting.ends_on) - Date.parse(meeting.starts_on)) / 86_400_000 + 1
        : Infinity;

/**
 * A section as the sessions the schedule works with. Meetings that only run for a few days are
 * dropped, meetings at the same time are merged (Mon and Wed at 8:35 are one session), and each
 * remaining weekly time becomes a session. Most sections have exactly one.
 */
function toSessions(row: SectionRow, rooms: Map<string, Room>): PlacedSession[] {
    const base = {
        term: row.term,
        section: row.section,
        type: row.type,
        crn: row.crn,
        course: row.course as CourseAndSubjectCode,
        instructors: row.instructors.map((instructor) => instructor.name),
    };
    if (row.meetings.length === 0) {
        const session: ClassSession = { ...base, days: [], time: { start: "C/D", end: "C/D" }, location: "", campus: null };
        return [{ session, rooms: new Set() }];
    }

    const recurring = row.meetings.filter((meeting) => spanDays(meeting) >= MIN_RECURRING_DAYS);
    const kept = recurring.length > 0 ? recurring : [[...row.meetings].sort((a, b) => spanDays(b) - spanDays(a))[0]];
    const timed = kept.filter((meeting) => meeting.start_time && meeting.end_time);
    const groups = new Map<string, MeetingRow[]>();
    for (const meeting of timed.length > 0 ? timed : kept) {
        const key = `${meeting.start_time}-${meeting.end_time}`;
        groups.set(key, [...(groups.get(key) ?? []), meeting]);
    }

    const placed = [...groups.values()].map((meetings): PlacedSession => {
        const [first] = meetings;
        const meetingDays = new Set(meetings.flatMap((meeting) => meeting.days));
        // A room booked for part of the term (a move after a few weeks) is still one of the section's rooms.
        const roomIds = new Set(meetings.flatMap((meeting) => meeting.rooms));
        const longest = [...meetings].sort((a, b) => spanDays(b) - spanDays(a)).find((meeting) => meeting.location);
        const mainRoom = longest?.rooms.map((id) => rooms.get(id)).find(Boolean);
        return {
            session: {
                ...base,
                days: appDays.filter((day) => meetingDays.has(day)) as Day[],
                time:
                    first.start_time && first.end_time
                        ? { start: toTime(first.start_time) as Time, end: toTime(first.end_time) as Time }
                        : { start: "C/D", end: "C/D" },
                location: longest?.location ?? "",
                campus: mainRoom?.campus ?? null,
            },
            rooms: roomIds,
        };
    });
    return mergeOverlapping(placed);
}

/**
 * Times of one section that overlap on the same days are one block in several rooms (a studio booked
 * 14:05-17:25 in one room and 14:35-17:25 in another), so they become a single session.
 */
function mergeOverlapping(placed: PlacedSession[]): PlacedSession[] {
    const merged: PlacedSession[] = [];
    for (const item of [...placed].sort((a, b) => a.session.time.start.localeCompare(b.session.time.start))) {
        const { session } = item;
        const block = merged.find(
            ({ session: other }) =>
                other.time.start !== "C/D" &&
                session.time.start !== "C/D" &&
                other.days.join() === session.days.join() &&
                session.time.start < other.time.end &&
                other.time.start < session.time.end,
        );
        if (!block) {
            merged.push(item);
            continue;
        }
        item.rooms.forEach((room) => block.rooms.add(room));
        if (session.time.end > block.session.time.end) {
            block.session.time = { start: block.session.time.start, end: session.time.end };
        }
    }
    return merged;
}

const typeRank = (type: string) =>
    sessionTypeOrder.includes(type) ? sessionTypeOrder.indexOf(type) : sessionTypeOrder.length;

function buildCourses(
    rows: CourseRow[],
    sectionRows: SectionRow[],
    prerequisites: Map<string, string[]>,
    listed: Term[],
    rooms: Map<string, Room>,
) {
    const sectionsByCourse = new Map<string, SectionRow[]>();
    for (const row of sectionRows) sectionsByCourse.set(row.course, [...(sectionsByCourse.get(row.course) ?? []), row]);
    const roomSessions = new Map<Term, Map<string, ClassSession[]>>();

    const courses = rows.map((row): Course => {
        const sections = (sectionsByCourse.get(row.code) ?? []).sort(
            (a, b) =>
                termIndex(listed, a.term) - termIndex(listed, b.term) ||
                typeRank(a.type) - typeRank(b.type) ||
                a.section.localeCompare(b.section, undefined, { numeric: true }) ||
                a.crn.localeCompare(b.crn),
        );

        const instructorsByTerm: Record<Term, string[]> = {};
        const enrollmentByTerm: Record<Term, Enrollment> = {};
        for (const term of listed) {
            const inTerm = sections.filter((section) => section.term === term);
            if (inTerm.length === 0) continue;
            // Primary instructors first, in section order.
            const people = [...inTerm.flatMap((section) => section.instructors)].sort(
                (a, b) => Number(b.is_primary) - Number(a.is_primary),
            );
            instructorsByTerm[term] = [...new Set(people.map((person) => person.name))];
            // Seats are counted over lectures, or the course's main kind of section when it has none, so a
            // lecture's seats aren't added to its labs'.
            const mainType = inTerm.some((section) => section.kind === "lecture") ? "lecture" : inTerm[0].kind;
            const counted = inTerm.filter((section) => section.kind === mainType);
            enrollmentByTerm[term] = {
                enrolled: counted.reduce((total, section) => total + (section.enrolled ?? 0), 0),
                capacity: counted.reduce((total, section) => total + (section.capacity ?? 0), 0),
            };
        }

        return {
            subjectCode: row.subject_code as SubjectCode,
            courseCode: row.number as CourseCode,
            title: row.title,
            creditHours: Number(row.credits ?? 0),
            description: row.description ?? "",
            prerequisites: (prerequisites.get(row.code) ?? []) as CourseAndSubjectCode[],
            termClasses: sections.flatMap((section) => {
                const placed = toSessions(section, rooms);
                for (const { session, rooms: roomIds } of placed) {
                    const byRoom = roomSessions.get(session.term) ?? new Map<string, ClassSession[]>();
                    roomIds.forEach((id) => byRoom.set(id, [...(byRoom.get(id) ?? []), session]));
                    roomSessions.set(session.term, byRoom);
                }
                return placed.map(({ session }) => session);
            }),
            enrollmentByTerm,
            instructorsByTerm,
        };
    });
    return { courses, roomSessions };
}

async function readFromSupabase(university: string): Promise<CatalogRows> {
    const db = publicClient();
    const read = <T,>({ source, columns, order, filters }: {
        source: string;
        columns: string;
        order: string[];
        filters?: Record<string, string>;
    }) => readAll<T>(db, source, columns, university, order, filters);

    const [terms, subjects, courses, sections, prerequisites, ratings, exams, rooms] = await Promise.all([
        read<CatalogRows["terms"][number]>(CATALOG_SOURCES.terms),
        read<Subject>(CATALOG_SOURCES.subjects),
        read<CourseRow>(CATALOG_SOURCES.courses),
        readAllById<SectionRow>(db, CATALOG_SOURCES.sections.source, CATALOG_SOURCES.sections.columns, university),
        read<CatalogRows["prerequisites"][number]>(CATALOG_SOURCES.prerequisites),
        read<CatalogRows["ratings"][number]>(CATALOG_SOURCES.ratings),
        read<CatalogRows["exams"][number]>(CATALOG_SOURCES.exams),
        read<CatalogRows["rooms"][number]>(CATALOG_SOURCES.rooms),
    ]);
    return { terms, subjects, courses, sections, prerequisites, ratings, exams, rooms };
}

/** The university's catalog file in this deployment, or null when it has none (in dev, or a new university). */
async function readFromFile(university: string): Promise<CatalogRows | null> {
    if (!getUniversity(university)) return null;
    try {
        // "catalogs" spelled out: from a variable, the build can't tell which folder this reads, so it
        // bundles the whole project into every function and the deploy fails on their size.
        const file = await readFile(join(process.cwd(), "catalogs", catalogFileName(university)));
        return JSON.parse(gunzipSync(file).toString()) as CatalogRows;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`Couldn't read the ${university} catalog file; reading Supabase`, error);
        }
        return null;
    }
}

async function loadCatalog(university: string): Promise<Catalog> {
    const file = await readFromFile(university);
    const {
        terms: termRows,
        subjects: subjectRows,
        courses: courseRows,
        sections: sectionRows,
        prerequisites: requisiteRows,
        ratings: ratingRows,
        exams: examRows,
        rooms: roomRows,
    } = file ?? (await readFromSupabase(university));

    const terms = termRows.map((row) => ({
        code: row.code,
        name: row.name,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        isListed: row.is_listed,
    }));
    const listed = listedCodes(terms);
    if (listed.length === 0) throw new Error(`No terms are listed for ${university}; run the data refresh`);

    // Only link to prerequisites that are on the timetable, so the links never lead to a missing page.
    const catalogCodes = new Set(courseRows.map((row) => row.code));
    const prerequisites = new Map<string, string[]>();
    for (const { course, required } of requisiteRows) {
        if (catalogCodes.has(required)) prerequisites.set(course, [...(prerequisites.get(course) ?? []), required]);
    }

    const rooms = new Map(roomRows.map((room) => [room.id, room]));
    const { courses, roomSessions } = buildCourses(courseRows, sectionRows, prerequisites, listed, rooms);
    const exams: ExamSchedule = {};
    for (const row of examRows) {
        const byCourse = (exams[row.term] ??= {});
        (byCourse[row.course] ??= []).push({
            section: row.section,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            location: row.location,
        });
    }

    return {
        terms,
        listed,
        subjects: subjectRows,
        courses,
        byCode: new Map(courses.map((course) => [courseKey(course), course])),
        ratings: new Map(
            ratingRows.map((row) => [
                row.match_name,
                {
                    firstName: row.first_name,
                    lastName: row.last_name,
                    profileUrl: row.profile_url,
                    rating: row.rating === null ? null : Number(row.rating),
                    difficulty: row.difficulty === null ? null : Number(row.difficulty),
                    wouldTakeAgain: row.would_take_again === null ? null : Number(row.would_take_again),
                    ratingCount: row.rating_count,
                },
            ]),
        ),
        exams,
        rooms,
        roomSessions,
        derived: new Map(),
        fromFile: file !== null,
    };
}

const snapshots = new Map<string, { catalog: Catalog; expiresAt: number }>();
const loading = new Map<string, Promise<Catalog>>();
const failures = new Map<string, { error: unknown; retryAt: number }>();

/**
 * A university's catalog, reloaded every few minutes unless it came from a file. If a reload fails the
 * last good catalog keeps being served, so a Supabase hiccup doesn't take the site down. With nothing
 * to serve, requests fail straight away for a minute instead of each adding to a busy database's load.
 */
function currentCatalog(university: string): Promise<Catalog> {
    const snapshot = snapshots.get(university);
    if (snapshot && Date.now() < snapshot.expiresAt) return Promise.resolve(snapshot.catalog);
    const failure = failures.get(university);
    if (!snapshot && failure && Date.now() < failure.retryAt) return Promise.reject(failure.error);
    let pending = loading.get(university);
    if (!pending) {
        pending = loadCatalog(university)
            .then((catalog) => {
                snapshots.set(university, {
                    catalog,
                    expiresAt: catalog.fromFile ? Infinity : Date.now() + FRESH_FOR_MS,
                });
                failures.delete(university);
                return catalog;
            })
            .catch((error) => {
                const previous = snapshots.get(university);
                if (!previous) {
                    failures.set(university, { error, retryAt: Date.now() + RETRY_AFTER_FAILURE_MS });
                    throw error;
                }
                console.error(`Couldn't reload the ${university} catalog; serving the previous one`, error);
                previous.expiresAt = Date.now() + RETRY_AFTER_FAILURE_MS;
                return previous.catalog;
            })
            .finally(() => loading.delete(university));
        loading.set(university, pending);
    }
    return pending;
}

const getCatalog = cache(currentCatalog);

/** Forgets the in-memory catalogs so the next request reads them again (after a data refresh). */
export function clearCatalog() {
    snapshots.clear();
}

/** Computes something from the catalog once per catalog load. */
function derive<T>(catalog: Catalog, key: string, compute: () => T): T {
    if (!catalog.derived.has(key)) catalog.derived.set(key, compute());
    return catalog.derived.get(key) as T;
}

/** How many courses each university has on its timetable, counted without loading their catalogs. */
export async function getCourseCounts(): Promise<Record<string, number>> {
    const db = publicClient();
    const counts = await Promise.all(
        universities.map(async ({ id }) => {
            const { count, error } = await db
                .from("catalog_courses")
                .select("code", { count: "exact", head: true })
                .eq("university_id", id);
            if (error) throw error;
            return [id, count ?? 0] as const;
        }),
    );
    return Object.fromEntries(counts);
}

/** The codes of a university's courses on its timetable, without loading its catalog (for the sitemap). */
export async function getCourseCodes(university: string): Promise<string[]> {
    const rows = await readAll<{ code: string }>(publicClient(), "catalog_courses", "code", university, ["code"]);
    return rows.map((row) => row.code);
}

/** Every term the database knows, oldest first; `isListed` marks the ones on the timetable. */
export async function getTerms(university: string): Promise<TermInfo[]> {
    return (await getCatalog(university)).terms;
}

/** The term running today (or the next one), decided on the server. */
export async function getCurrentTerm(university: string): Promise<Term> {
    return currentTermCode(await getTerms(university), dateIn(getUniversity(university)?.timezone ?? "UTC"));
}

export async function getListedTerms(university: string): Promise<Term[]> {
    return (await getCatalog(university)).listed;
}

export async function getSubjects(university: string): Promise<Subject[]> {
    return (await getCatalog(university)).subjects;
}

/** Every course on the timetable. */
export async function getCourses(university: string): Promise<Course[]> {
    return (await getCatalog(university)).courses;
}

export async function getCreditHourOptions(university: string): Promise<number[]> {
    const catalog = await getCatalog(university);
    return derive(catalog, "creditHours", () =>
        [...new Set(catalog.courses.map((course) => course.creditHours))].sort((a, b) => a - b),
    );
}

export async function getCourse(university: string, code: string): Promise<Course | undefined> {
    return (await getCatalog(university)).byCode.get(code.toUpperCase());
}

function toSummary(course: Course): CourseSummary {
    return { code: courseKey(course), title: course.title, creditHours: course.creditHours };
}

export function toListItem({
    subjectCode,
    courseCode,
    title,
    creditHours,
    termClasses,
    enrollmentByTerm,
    instructorsByTerm,
}: Course): CourseListItem {
    return { subjectCode, courseCode, title, creditHours, termClasses, enrollmentByTerm, instructorsByTerm };
}

export async function getCourseIndex(university: string): Promise<CourseSummary[]> {
    const catalog = await getCatalog(university);
    return derive(catalog, "index", () => catalog.courses.map(toSummary));
}

export async function getCourseList(university: string): Promise<CourseListItem[]> {
    const catalog = await getCatalog(university);
    return derive(catalog, "list", () => catalog.courses.map(toListItem));
}

/** Courses that list the given course as a prerequisite. */
export async function getUnlockedCourses(university: string, code: CourseAndSubjectCode): Promise<CourseSummary[]> {
    const catalog = await getCatalog(university);
    const unlocks = derive(catalog, "unlocks", () => {
        const map = new Map<string, CourseSummary[]>();
        for (const course of catalog.courses) {
            for (const prerequisite of course.prerequisites) {
                map.set(prerequisite, [...(map.get(prerequisite) ?? []), toSummary(course)]);
            }
        }
        return map;
    });
    return unlocks.get(code) ?? [];
}

/** RateMyProfessors summaries for the given timetable names. */
export async function getRatingSummaries(university: string, names: string[]): Promise<Record<string, RatingSummary>> {
    const { ratings } = await getCatalog(university);
    return Object.fromEntries(names.map((name) => [name, summarizeRating(name, ratings.get(name))]));
}

/** Overall RateMyProfessors rating by instructor name, for instructors who have one. */
export async function getRatingsByName(university: string): Promise<Record<string, number>> {
    const catalog = await getCatalog(university);
    return derive(catalog, "ratingsByName", () =>
        Object.fromEntries(
            [...catalog.ratings]
                .filter(([, rating]) => rating.rating !== null && rating.rating > 0)
                .map(([name, rating]) => [name, rating.rating as number]),
        ),
    );
}

/** Distinct instructors across every term of a course. */
export function getCourseInstructors(course: Course): string[] {
    return [...new Set(Object.values(course.instructorsByTerm).flat())];
}

export async function getInstructorList(university: string, currentTerm: Term): Promise<InstructorListItem[]> {
    const catalog = await getCatalog(university);
    const coursesByName = new Map<string, Map<Term, Set<CourseAndSubjectCode>>>();
    for (const course of catalog.courses) {
        for (const [term, names] of Object.entries(course.instructorsByTerm)) {
            for (const name of names) {
                const byTerm = coursesByName.get(name) ?? new Map<Term, Set<CourseAndSubjectCode>>();
                byTerm.set(term, (byTerm.get(term) ?? new Set()).add(courseKey(course)));
                coursesByName.set(name, byTerm);
            }
        }
    }

    const fromNow = catalog.listed.slice(Math.max(termIndex(catalog.listed, currentTerm), 0));
    return [...coursesByName.entries()].map(([name, byTerm]) => {
        const all = new Set([...byTerm.values()].flatMap((codes) => [...codes]));
        const teachingTerm = fromNow.find((term) => byTerm.has(term));
        const subjectOf = (code: CourseAndSubjectCode) => catalog.byCode.get(code)?.subjectCode ?? code;
        return {
            ...summarizeRating(name, catalog.ratings.get(name)),
            subjects: [...new Set([...all].map(subjectOf))],
            teaching: teachingTerm ? { term: teachingTerm, courses: [...byTerm.get(teachingTerm)!] } : null,
            courseCount: all.size,
        };
    });
}

/** Final exams by term and course. */
export async function getExamSchedule(university: string): Promise<ExamSchedule> {
    return (await getCatalog(university)).exams;
}

/** The rooms with timed classes in a term, each with those sessions. */
export async function getRoomSessions(university: string, term: Term): Promise<Map<string, ClassSession[]>> {
    const catalog = await getCatalog(university);
    return derive(catalog, `rooms:${term}`, () => {
        const rooms = new Map<string, ClassSession[]>();
        for (const [id, sessions] of catalog.roomSessions.get(term) ?? []) {
            const timed = sessions.filter((session) => session.time.start !== "C/D" && session.days.length > 0);
            if (timed.length > 0) rooms.set(id, timed);
        }
        return rooms;
    });
}

export async function getRooms(university: string): Promise<Map<string, Room>> {
    return (await getCatalog(university)).rooms;
}
