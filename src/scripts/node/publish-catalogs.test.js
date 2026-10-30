import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_SOURCES } from "../../lib/catalog-sources.mjs";
import { assertPublishable, readCatalog } from "./publish-catalogs.js";

function fakeDb() {
    const calls = [];
    const record = (method) => async (table, columns, filters, order) => {
        calls.push({ method, table, columns, filters, order });
        return [{ from: table }];
    };
    return { calls, selectAll: record("selectAll"), selectAllByKey: record("selectAllByKey") };
}

test("reads every source for that university only", async () => {
    const db = fakeDb();
    const rows = await readCatalog(db, "dal");
    assert.deepEqual(Object.keys(rows), Object.keys(CATALOG_SOURCES));
    for (const { filters } of db.calls) assert.equal(filters.university_id, "eq.dal");
});

test("reads sections by id, and only prerequisites from the requisites", async () => {
    const db = fakeDb();
    await readCatalog(db, "dal");
    assert.equal(db.calls.find(({ table }) => table === "catalog_sections").method, "selectAllByKey");
    const requisites = db.calls.find(({ table }) => table === "course_requisite_codes");
    assert.equal(requisites.filters.kind, "eq.prerequisite");
    assert.equal(requisites.order, "course,required");
});

test("won't replace a file with a catalog the site couldn't show", () => {
    const rows = { terms: [{ is_listed: true }], courses: [{}], sections: [{}] };
    assert.doesNotThrow(() => assertPublishable("dal", rows));
    assert.throws(() => assertPublishable("dal", { ...rows, terms: [{ is_listed: false }] }), /no terms/);
    assert.throws(() => assertPublishable("dal", { ...rows, courses: [] }), /no courses/);
    assert.throws(() => assertPublishable("dal", { ...rows, sections: [] }), /no sections/);
});
