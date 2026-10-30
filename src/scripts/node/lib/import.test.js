import assert from "node:assert/strict";
import test from "node:test";
import { httpError, isUnreachable, retryBusy } from "./import.js";

const busy = () => Object.assign(new Error("canceling statement due to statement timeout"), { status: 500, code: "57014" });

test("tries a cancelled import again until it goes through", async () => {
    const waits = [];
    let calls = 0;
    const result = await retryBusy("rpc/import_timetable", async () => {
        if (++calls < 3) throw busy();
        return { sections: 400 };
    }, { delays: [1, 2, 3], sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(result, { sections: 400 });
    assert.deepEqual(waits, [1, 2]);
});

test("gives up after the last delay", async () => {
    let calls = 0;
    await assert.rejects(
        retryBusy("rpc/import_timetable", async () => { calls++; throw busy(); }, { delays: [1, 2], sleep: async () => {} }),
        /statement timeout/,
    );
    assert.equal(calls, 3);
});

test("tries again after a 500 with no Postgres code, as the API sends when the database stalls", async () => {
    let calls = 0;
    const result = await retryBusy("count catalog_sections", async () => {
        if (++calls < 2) throw httpError({ status: 500 });
        return 9066;
    }, { delays: [1], sleep: async () => {} });
    assert.equal(result, 9066);
});

test("does not repeat a call the database refused for what was sent", async () => {
    let calls = 0;
    const refused = Object.assign(new Error("Duplicate sections"), { status: 400, code: "P0001" });
    await assert.rejects(
        retryBusy("rpc/import_timetable", async () => { calls++; throw refused; }, { delays: [1], sleep: async () => {} }),
        /Duplicate sections/,
    );
    assert.equal(calls, 1);
});

test("tells a university's server being down from a broken scraper", () => {
    const timeout = new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    assert.ok(isUnreachable(new Error("classSearch/getTerms: fetch failed", { cause: timeout })));
    assert.ok(isUnreachable(new Error("Course search page: HTTP 503", { cause: httpError({ status: 503 }) })));

    assert.ok(!isUnreachable(new Error("Course search page: HTTP 404", { cause: httpError({ status: 404 }) })));
    assert.ok(!isUnreachable(new TypeError("Cannot read properties of undefined (reading 'code')")));
    // Wrapped without its cause, the message alone isn't trusted.
    assert.ok(!isUnreachable(new Error("classSearch/getTerms: fetch failed")));
});
