import assert from "node:assert/strict";
import test from "node:test";
import { importDetails, importTimetable } from "./refresh.js";

function timetable(counts) {
    return {
        terms: [{ code: "fall" }, { code: "winter" }],
        subjects: Object.keys(counts).map((code) => ({ code, name: code })),
        courses: Object.keys(counts).map((code) => ({ code: `${code}100`, subject_code: code })),
        sections: Object.entries(counts).flatMap(([code, count]) =>
            Array.from({ length: count }, (_, i) => ({
                course: `${code}100`, term: i % 2 ? "winter" : "fall", crn: `${code}${i}`,
            })),
        ),
        failedSubjects: [],
    };
}

function database(subjects = []) {
    const calls = [];
    return {
        calls,
        async selectAll() { return subjects.map((code) => ({ code })); },
        async rpc(name, args) {
            calls.push({ name, ...args });
            return { sections: args.p_payload?.sections.length ?? 0, deleted: 0 };
        },
    };
}

test("imports every section once and keeps complete term/subject scopes in small batches", async () => {
    const data = timetable({ A: 250, B: 200, C: 100, D: 900, E: 50 });
    const db = database();
    await importTimetable(db, "school", data);
    const batches = db.calls.filter((call) => call.name === "import_timetable").map((call) => call.p_payload);
    assert.deepEqual(batches.map((batch) => batch.sections.length), [275, 450, 25, 275, 450, 25]);
    assert.deepEqual(
        batches.flatMap((batch) => batch.sections).map((section) => section.crn).sort(),
        data.sections.map((section) => section.crn).sort(),
    );
    for (const batch of batches) {
        assert.equal(new Set(batch.scope.map((scope) => scope.term)).size, 1);
        assert.ok(batch.sections.every((section) => section.term === batch.scope[0].term));
    }
    for (const term of data.terms) {
        for (const subject of data.subjects) {
            const scope = { term: term.code, subject: subject.code };
            const containing = batches.filter((batch) => batch.scope.some((item) =>
                item.term === scope.term && item.subject === scope.subject));
            assert.equal(containing.length, 1, "a term/subject must never be replaced in multiple calls");
            const inScope = (section) => section.term === term.code && section.course === `${subject.code}100`;
            assert.equal(containing[0].sections.filter(inScope).length, data.sections.filter(inScope).length);
        }
    }
    assert.equal(db.calls[0].name, "import_terms");
    assert.equal(db.calls.at(-1).name, "list_terms");
});

test("keeps the subject limit for sparse timetables", async () => {
    const data = timetable(Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`S${i}`, 1])));
    const db = database();
    await importTimetable(db, "school", data);
    assert.deepEqual(db.calls.filter((call) => call.p_payload).map((call) => call.p_payload.subjects.length),
        [20, 20, 5, 20, 20, 5]);
});

test("excludes failed subjects but clears vanished subjects only in listed terms", async () => {
    const data = timetable({ A: 1, FAILED: 1 });
    data.failedSubjects = ["FAILED"];
    const db = database(["A", "FAILED", "REMOVED"]);
    await importTimetable(db, "school", data);
    const batches = db.calls.filter((call) => call.p_payload).map((call) => call.p_payload);
    assert.deepEqual(batches.flatMap((batch) => batch.scope), [
        { term: "fall", subject: "A" }, { term: "fall", subject: "REMOVED" },
        { term: "winter", subject: "A" }, { term: "winter", subject: "REMOVED" },
    ]);
    for (const batch of batches) {
        assert.deepEqual(batch.subjects.map((subject) => subject.code), ["A"]);
        assert.deepEqual(batch.courses.map((course) => course.code), ["A100"]);
    }
    assert.deepEqual(batches.map((batch) => batch.sections.map((section) => section.crn)), [["A0"], []]);
});

test("refuses empty timetables before making any writes", async () => {
    const db = database(["A"]);
    await assert.rejects(importTimetable(db, "school", timetable({})), /Scraped no sections/);
    assert.deepEqual(db.calls, []);
});

test("does not list terms when an import fails", async () => {
    const db = database();
    const rpc = db.rpc;
    db.rpc = async (name, args) => {
        if (name === "import_timetable") throw new Error("statement timeout");
        return rpc(name, args);
    };
    await assert.rejects(importTimetable(db, "school", timetable({ A: 1 })), /statement timeout/);
    assert.equal(db.calls.some((call) => call.name === "list_terms"), false);
});

test("empty descriptions warn on full refreshes, not missing-only refreshes", async () => {
    const courses = Array.from({ length: 25 }, (_, i) => ({ code: `A${i}` }));
    const db = {
        // Codes only; the second read is the courses that have a description.
        async selectAll(table, columns, filters) {
            assert.equal(columns, "code");
            return filters.description ? [{ code: "KNOWN" }] : [...courses, { code: "KNOWN" }];
        },
        async rpc() { return 0; },
    };
    const scraper = {
        async *scrapeCourseDetails(selected) {
            assert.deepEqual(selected, courses);
            // Banner omits courses for which its calendar supplies no description.
            yield [];
        },
    };
    assert.deepEqual(await importDetails(db, "school", scraper,
        { courses: [...courses, { code: "KNOWN" }] }, "missing"), []);
    assert.deepEqual(await importDetails(db, "school", scraper, { courses }, "all"),
        ["Fetched details for 25 courses and none had a description"]);
});
