import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/constants";
import { getCourseCodes } from "@/lib/data";
import { universities, universityPath } from "@/lib/university";

/** Rebuilt daily, after the timetables refresh. */
export const revalidate = 86400;

const SHARED_PAGES = ["/explore", "/schedule", "/rooms", "/instructors"];

/** The landing page, each university's pages and every course on a timetable: about 25,000 addresses. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const url = (path: string) => `${SITE_URL}${path}`;
    const perUniversity = await Promise.all(
        universities.map(async ({ id }) => [
            { url: url(universityPath(id, "/")), changeFrequency: "daily" as const, priority: 0.9 },
            ...SHARED_PAGES.map((page) => ({
                url: url(universityPath(id, page)),
                changeFrequency: "daily" as const,
                priority: 0.7,
            })),
            // A busy database shouldn't fail the deploy: that university's courses are left out until
            // the next daily rebuild.
            ...(
                await getCourseCodes(id).catch((error) => {
                    console.error(`Couldn't list ${id}'s courses for the sitemap`, error);
                    return [];
                })
            ).map((code) => ({
                url: url(universityPath(id, `/${code}`)),
                changeFrequency: "daily" as const,
                priority: 0.6,
            })),
        ]),
    );
    return [{ url: url("/"), changeFrequency: "weekly", priority: 1 }, ...perUniversity.flat()];
}
