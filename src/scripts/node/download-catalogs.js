/**
 * Runs before `next build`. Downloads each university's catalog file (publish-catalogs.js) into the
 * deployment, so serving the site doesn't read catalogs from Supabase. Never fails the build: a
 * university without a file is read from Supabase instead, as a new one is until its first refresh.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CATALOG_BUCKET, CATALOG_DIRECTORY, catalogFileName } from "../../lib/catalog-sources.mjs";
import { loadEnv, log } from "./lib/import.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const TIMEOUT_MS = 30_000;

async function main() {
    const url = loadEnv().NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
        log("NEXT_PUBLIC_SUPABASE_URL isn't set; building without catalog files");
        return;
    }
    const directory = path.join(ROOT, CATALOG_DIRECTORY);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });

    const ids = fs.readdirSync(path.join(HERE, "universities")).filter((file) => file.endsWith(".js")).map((file) => file.slice(0, -3));
    const base = `${url.replace(/\/$/, "")}/storage/v1/object/public/${CATALOG_BUCKET}`;
    // The query skips any copy a CDN kept from before the last refresh.
    const version = Date.now();
    const missing = [];
    let bytes = 0;
    await Promise.all(
        ids.map(async (university) => {
            const name = catalogFileName(university);
            try {
                const response = await fetch(`${base}/${name}?v=${version}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const file = Buffer.from(await response.arrayBuffer());
                fs.writeFileSync(path.join(directory, name), file);
                bytes += file.length;
            } catch (error) {
                missing.push(`${university} (${error.message})`);
            }
        }),
    );
    log(`Downloaded ${ids.length - missing.length} of ${ids.length} catalog files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
    if (missing.length) log(`Will read these from Supabase: ${missing.join(", ")}`);
}

main().catch((error) => log(`Building without catalog files: ${error.message}`));
