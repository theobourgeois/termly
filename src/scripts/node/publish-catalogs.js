/**
 * Runs after the daily refresh. Saves each university's catalog as one gzipped file in Storage, which
 * the next build downloads (download-catalogs.js) so the site reads its catalogs from disk rather
 * than from Supabase. One university failing keeps its last file and leaves the others alone.
 *
 * With --content it also saves what course pages show besides the catalog (RateMyProfessors reviews
 * and syllabi) as a second file. That's only needed after the weekly refresh, which is when reviews
 * change, so the daily runs don't read them all again: everything read here counts against the
 * free plan's egress. A university with no content file yet gets one either way.
 *
 *     node publish-catalogs.js            # every university
 *     node publish-catalogs.js dal kpu
 *     node publish-catalogs.js --content dal   # the catalog and the content file
 *     node publish-catalogs.js --dry-run dal   # only print each file's size
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { gzipSync } from "zlib";
import {
    CATALOG_BUCKET,
    CATALOG_SOURCES,
    CONTENT_SOURCES,
    catalogFileName,
    contentFileName,
} from "../../lib/catalog-sources.mjs";
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

/**
 * The university's reviews and syllabi. `generatedAt` is taken before reading, so a review hidden
 * while this runs is still caught by the site's check for changes made since (src/lib/course-content.ts).
 */
export async function readContent(db, university) {
    const content = { generatedAt: new Date().toISOString() };
    for (const [name, { source, columns, order, filters = {} }] of Object.entries(CONTENT_SOURCES)) {
        content[name] = await db.selectAll(source, columns, { university_id: `eq.${university}`, ...filters }, order.join(","));
    }
    return content;
}

/** Throws rather than replace a good file with one the site couldn't show. */
export function assertPublishable(university, rows) {
    if (!rows.terms.some((term) => term.is_listed)) throw new Error(`${university}: no terms are listed`);
    if (rows.courses.length === 0) throw new Error(`${university}: no courses`);
    if (rows.sections.length === 0) throw new Error(`${university}: no sections`);
}

const storageUrl = () => `${loadEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object`;

/** Whether the bucket has the file. When Storage doesn't say, assumes it does, so nothing is read for it. */
async function published(name) {
    const response = await fetch(`${storageUrl()}/public/${CATALOG_BUCKET}/${name}`, { method: "HEAD" });
    // Storage answers a missing public file with a 400 or a 404, depending on the version.
    return response.status !== 400 && response.status !== 404;
}

async function upload(name, file) {
    const env = loadEnv();
    const key = env.SUPABASE_SECRET_KEY;
    const response = await fetch(
        `${storageUrl()}/${CATALOG_BUCKET}/${name}`,
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
    const withContent = args.includes("--content");
    const scrapers = path.join(path.dirname(fileURLToPath(import.meta.url)), "universities");
    const named = args.filter((arg) => !arg.startsWith("--"));
    const ids = named.length
        ? named
        : fs.readdirSync(scrapers).filter((file) => file.endsWith(".js")).map((file) => file.slice(0, -3)).sort();

    const db = connect({ readOnly: dryRun });
    let errors = 0;
    for (const university of ids) {
        try {
            const rows = await readCatalog(db, university);
            assertPublishable(university, rows);
            const file = gzipSync(JSON.stringify(rows), { level: 9 });
            if (!dryRun) await upload(catalogFileName(university), file);
            log(`${university}: ${rows.courses.length} courses, ${rows.sections.length} sections, ${(file.length / 1024).toFixed(0)} KiB`);
        } catch (error) {
            errors++;
            log(`${university}: keeping its last file: ${error.message}`);
        }
        try {
            if (!withContent && (await published(contentFileName(university)))) continue;
            const content = await readContent(db, university);
            const file = gzipSync(JSON.stringify(content), { level: 9 });
            if (!dryRun) await upload(contentFileName(university), file);
            log(`${university}: ${content.rmpReviews.length} reviews, ${content.syllabi.length} syllabi, ${(file.length / 1024).toFixed(0)} KiB`);
        } catch (error) {
            errors++;
            log(`${university}: keeping its last content file: ${error.message}`);
        }
    }
    if (errors) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
