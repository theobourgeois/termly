import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { unstable_cache } from "next/cache";
import { contentFileName } from "./catalog-sources.mjs";
import { RMP_REVIEW_COLUMNS, type RmpReview } from "./rmp-reviews";
import { adminClient } from "./supabase/admin";
import { publicClient } from "./supabase/public";
import { SYLLABUS_COLUMNS, syllabusTermOrder, type Syllabus } from "./syllabi";
import type { CourseAndSubjectCode } from "./types";
import { getUniversity } from "./university";

/**
 * What course pages show besides the catalog: RateMyProfessors reviews and syllabi. They come from the
 * university's content file in the deployment (src/scripts/node/publish-catalogs.js), so rendering a
 * course page reads nothing from Supabase however many crawlers ask for one. Each daily deploy empties
 * the page cache, and crawlers then asked for tens of thousands of pages, each reading its reviews
 * from Supabase, until the free plan's egress ran out (Nov 2026).
 *
 * Moderators change these between files (a hidden review, an approved syllabus), so what changed
 * since the file was written is read once per university and cached until a moderator changes
 * something again (`revalidateTag(courseContentTag(university))`).
 *
 * In development there are no files, and each page reads its course's rows from Supabase instead.
 */

type ContentFile = {
    generatedAt: string;
    rmpReviews: (RmpReview & { course_code: string })[];
    syllabi: Syllabus[];
};

type Content = {
    generatedAt: string;
    /** Per course, newest first. */
    reviews: Map<string, RmpReview[]>;
    /** Per course, cross-listings included. */
    syllabi: Map<string, Syllabus[]>;
};

type Changes = { hiddenReviews: string[]; syllabi: Syllabus[] };

const FROM_FILES = process.env.NODE_ENV === "production";

const append = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
};

async function readContent(university: string): Promise<Content | null> {
    if (!getUniversity(university)) return null;
    let parsed: ContentFile;
    try {
        // "catalogs" spelled out: see readFromFile in data.ts.
        const file = await readFile(join(process.cwd(), "catalogs", contentFileName(university)));
        parsed = JSON.parse(gunzipSync(file).toString()) as ContentFile;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`Couldn't read the ${university} content file`, error);
        }
        return null;
    }

    const reviews = new Map<string, RmpReview[]>();
    for (const { course_code: course, ...review } of parsed.rmpReviews) append(reviews, course, review);
    for (const list of reviews.values()) list.sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at));

    const syllabi = new Map<string, Syllabus[]>();
    for (const syllabus of parsed.syllabi) for (const code of syllabus.course_codes) append(syllabi, code, syllabus);

    return { generatedAt: parsed.generatedAt, reviews, syllabi };
}

/** Each university's content, read once per server instance: the file doesn't change within a deployment. */
const contents = new Map<string, Promise<Content | null>>();

function getContent(university: string): Promise<Content | null> {
    let content = contents.get(university);
    if (!content) {
        content = readContent(university);
        contents.set(university, content);
    }
    return content;
}

/** The cache tag of what moderators changed since a university's content file was written. */
export const courseContentTag = (university: string) => `course-content:${university}`;

/**
 * Reviews hidden and syllabi published or updated since `since`. One small read per university until
 * a moderator changes something. Hidden reviews need the secret key: other roles can't see them.
 */
function changesSince(university: string, since: string): Promise<Changes> {
    return unstable_cache(
        async (): Promise<Changes> => {
            const [hidden, syllabi] = await Promise.all([
                adminClient()
                    .from("external_reviews")
                    .select("id")
                    .eq("university_id", university)
                    .eq("source", "rmp")
                    .gt("hidden_at", since),
                publicClient().from("syllabi").select(SYLLABUS_COLUMNS).eq("university_id", university).gt("updated_at", since),
            ]);
            // Thrown rather than returned, so a failed read isn't cached.
            if (hidden.error) throw new Error(`external_reviews: ${hidden.error.message}`);
            if (syllabi.error) throw new Error(`syllabi: ${syllabi.error.message}`);
            return {
                hiddenReviews: (hidden.data as { id: string }[]).map((row) => row.id),
                syllabi: syllabi.data as unknown as Syllabus[],
            };
        },
        ["course-content-changes", university, since],
        { tags: [courseContentTag(university)], revalidate: 86400 },
    )().catch((error) => {
        console.error(`Couldn't check ${university}'s moderation since its content file`, error);
        return { hiddenReviews: [], syllabi: [] };
    });
}

/** RateMyProfessors reviews that mention the course, newest first. Empty if they can't be loaded. */
export async function getRmpReviews(university: string, code: CourseAndSubjectCode): Promise<RmpReview[]> {
    if (!FROM_FILES) return readRmpReviews(university, code);
    const content = await getContent(university);
    const reviews = content?.reviews.get(code) ?? [];
    if (reviews.length === 0) return [];
    const { hiddenReviews } = await changesSince(university, content!.generatedAt);
    return hiddenReviews.length ? reviews.filter((review) => !hiddenReviews.includes(review.id)) : reviews;
}

/** Public syllabi for the course, latest term first. Empty if they can't be loaded. */
export async function getSyllabi(university: string, code: CourseAndSubjectCode): Promise<Syllabus[]> {
    if (!FROM_FILES) return sortSyllabi(await readSyllabi(university, code));
    const content = await getContent(university);
    if (!content) return [];
    const changed = (await changesSince(university, content.generatedAt)).syllabi.filter((syllabus) =>
        syllabus.course_codes.includes(code),
    );
    const replaced = new Set(changed.map((syllabus) => syllabus.id));
    const published = (content.syllabi.get(code) ?? []).filter((syllabus) => !replaced.has(syllabus.id));
    return sortSyllabi([...published, ...changed]);
}

const sortSyllabi = (syllabi: Syllabus[]) => syllabi.sort((a, b) => syllabusTermOrder(b) - syllabusTermOrder(a));

async function readRmpReviews(university: string, code: CourseAndSubjectCode): Promise<RmpReview[]> {
    const { data, error } = await publicClient()
        .from("external_reviews")
        .select(RMP_REVIEW_COLUMNS)
        .eq("university_id", university)
        .eq("source", "rmp")
        .eq("course_code", code)
        .order("reviewed_at", { ascending: false });
    return error ? [] : (data as RmpReview[]);
}

async function readSyllabi(university: string, code: CourseAndSubjectCode): Promise<Syllabus[]> {
    const { data, error } = await publicClient()
        .from("syllabi")
        .select(SYLLABUS_COLUMNS)
        .eq("university_id", university)
        .contains("course_codes", [code]);
    return error ? [] : (data as Syllabus[]);
}
