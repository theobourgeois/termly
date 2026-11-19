/**
 * Runs after the daily refresh. Saves each university's catalog as one gzipped file in Storage, which
 * the next build downloads (download-catalogs.js) so the site reads its catalogs from disk rather
 * than from Supabase. One university failing keeps its last file and leaves the others alone.
 *
 * A file is only replaced when the catalog changed. The universities that changed are written to the
 * step's `changed` output (comma-separated), and `checked=true` once all were compared, so the
 * workflow only redeploys the site when there's something new to show: a deploy starts with no
 * cached pages, and every page crawlers visit is rendered again.
 *
 *     node publish-catalogs.js            # every university
 *     node publish-catalogs.js dal kpu
 *     node publish-catalogs.js --dry-run dal   # only print each file's size
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { gunzipSync, gzipSync } from "zlib";
import { CATALOG_BUCKET, CATALOG_SOURCES, catalogFileName } from "../../lib/catalog-sources.mjs";
import { connect, loadEnv, log } from "./lib/import.js";

/** The rows of every catalog source, one source at a time so a refresh's last step stays light. */
export async function readCatalog(db, university) {
    const filter = { university_id: `eq.${university}` };
    const rows = {};
    for (const [name, { source, columns, order, filters = {} }] of Object.entries(CATALOG_SOURCES)) {
        const wanted = { ...filter };
        for (const [column, value] of Object.entries(filters)) wanted[column] = `eq.${value}`;
        rows[name] = order
            ? await db.selectAll(source, columns, wanted, order.join(","))
            : await db.selectAllByKey(source, columns, wanted);
    }
    return rows;
}

/** Throws rather than replace a good file with one the site couldn't show. */
export function assertPublishable(university, rows) {
    if (!rows.terms.some((term) => term.is_listed)) throw new Error(`${university}: no terms are listed`);
    if (rows.courses.length === 0) throw new Error(`${university}: no courses`);
    if (rows.sections.length === 0) throw new Error(`${university}: no sections`);
}

/**
 * The catalog as a string that doesn't depend on the order rows came back in: a refresh can give
 * sections new ids, which reorders them without changing anything the site shows.
 */
function fingerprint(rows) {
    return JSON.stringify(
        Object.keys(rows)
            .sort()
            .map((name) => [name, rows[name].map((row) => JSON.stringify(row)).sort()]),
    );
}

/** The fingerprint of the file published last time, or null when there's none (or it can't be read). */
async function publishedFingerprint(university) {
    const url = loadEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
    try {
        // The query skips any copy a CDN kept.
        const response = await fetch(
            `${url}/storage/v1/object/public/${CATALOG_BUCKET}/${catalogFileName(university)}?v=${Date.now()}`,
            { signal: AbortSignal.timeout(60_000) },
        );
        if (!response.ok) return null;
        return fingerprint(JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()));
    } catch {
        return null;
    }
}

async function upload(university, file) {
    const env = loadEnv();
    const key = env.SUPABASE_SECRET_KEY;
    const response = await fetch(
        `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${CATALOG_BUCKET}/${catalogFileName(university)}`,
        {
            method: "POST",
            headers: {
                apikey: key,
                // Legacy service_role keys are JWTs and go in the Authorization header too.
                ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
                "Content-Type": "application/gzip",
                "Cache-Control": "max-age=60",
                "x-upsert": "true",
            },
            body: file,
        },
    );
    if (!response.ok) throw new Error(`Upload: HTTP ${response.status} ${await response.text()}`);
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const scrapers = path.join(path.dirname(fileURLToPath(import.meta.url)), "universities");
    const named = args.filter((arg) => !arg.startsWith("--"));
    const ids = named.length
        ? named
        : fs.readdirSync(scrapers).filter((file) => file.endsWith(".js")).map((file) => file.slice(0, -3)).sort();

    const db = connect({ readOnly: dryRun });
    let errors = 0;
    const changed = [];
    for (const university of ids) {
        try {
            const rows = await readCatalog(db, university);
            assertPublishable(university, rows);
            const summary = `${rows.courses.length} courses, ${rows.sections.length} sections`;
            if (fingerprint(rows) === (await publishedFingerprint(university))) {
                log(`${university}: ${summary}, unchanged`);
                continue;
            }
            const file = gzipSync(JSON.stringify(rows), { level: 9 });
            if (!dryRun) await upload(university, file);
            changed.push(university);
            log(`${university}: ${summary}, ${(file.length / 1024).toFixed(0)} KiB`);
        } catch (error) {
            errors++;
            log(`${university}: keeping its last file: ${error.message}`);
        }
    }
    log(changed.length ? `Changed: ${changed.join(", ")}` : "No catalog changed");
    if (process.env.GITHUB_OUTPUT && !dryRun) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.join(",")}\nchecked=true\n`);
    }
    if (errors) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
