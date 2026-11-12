/**
 * Runs before `next build`. Downloads each university's catalog file and content file
 * (publish-catalogs.js) into the deployment, so serving the site reads nothing from Supabase, and
 * writes each university's course codes to one small summary for the sitemap and the landing page.
 *
 * A university with no file yet (a new one, until its first refresh) is left out: its pages show
 * nothing rather than read Supabase. Any other failure (Storage down, or the project restricted for
 * going over its quota) fails the build, so the live deployment stays up with the files it has.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import {
    CATALOG_BUCKET,
    CATALOG_DIRECTORY,
    CATALOG_SUMMARY,
    catalogFileName,
    contentFileName,
} from "../../lib/catalog-sources.mjs";
import { loadEnv, log } from "./lib/import.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const TIMEOUT_MS = 30_000;

class Missing extends Error {}

/** The file's bytes; throws Missing when Storage has no such file. */
async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // Storage answers a missing public file with a 400 or a 404, depending on the version.
    if (response.status === 404 || response.status === 400) throw new Missing(`HTTP ${response.status}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return Buffer.from(await response.arrayBuffer());
}

async function main() {
    const url = loadEnv().NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
        log("NEXT_PUBLIC_SUPABASE_URL isn't set; building without catalog files");
        return;
    }
    const directory = path.join(ROOT, CATALOG_DIRECTORY);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });

    const ids = fs
        .readdirSync(path.join(HERE, "universities"))
        .filter((file) => file.endsWith(".js"))
        .map((file) => file.slice(0, -3))
        .sort();
    const base = `${url.replace(/\/$/, "")}/storage/v1/object/public/${CATALOG_BUCKET}`;
    // The query skips any copy a CDN kept from before the last refresh.
    const version = Date.now();
    const missing = [];
    const failed = [];
    const summary = {};
    let bytes = 0;
    await Promise.all(
        ids.flatMap((university) =>
            [catalogFileName(university), contentFileName(university)].map(async (name) => {
                try {
                    const file = await download(`${base}/${name}?v=${version}`);
                    fs.writeFileSync(path.join(directory, name), file);
                    bytes += file.length;
                    if (name === catalogFileName(university)) {
                        const { courses } = JSON.parse(gunzipSync(file).toString());
                        summary[university] = courses.map((course) => course.code);
                    }
                } catch (error) {
                    (error instanceof Missing ? missing : failed).push(`${name} (${error.message})`);
                }
            }),
        ),
    );
    fs.writeFileSync(path.join(directory, CATALOG_SUMMARY), JSON.stringify(summary));

    log(`Downloaded ${ids.length * 2 - missing.length - failed.length} of ${ids.length * 2} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
    if (missing.length) log(`Not published yet, so those pages show nothing: ${missing.join(", ")}`);
    if (failed.length) {
        const more = failed.length > 3 ? ` and ${failed.length - 3} more` : "";
        throw new Error(`Couldn't download ${failed.slice(0, 3).join(", ")}${more}`);
    }
}

main().catch((error) => {
    log(`Stopping the build so the live deployment keeps its files: ${error.message}`);
    process.exit(1);
});
