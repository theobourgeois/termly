import { getCourseIndex } from "@/lib/data";
import { requestedUniversity } from "@/lib/university";

/**
 * Every course's code, title and credits at a university, for search and for naming the courses on a
 * schedule. One response cached at Vercel's edge serves every page, instead of each page carrying
 * its own copy.
 */
export async function GET(request: Request) {
    const university = requestedUniversity(request);
    if (!university) return new Response("Unknown university", { status: 404 });

    return Response.json(await getCourseIndex(university), {
        headers: {
            // A new deployment (the daily data refresh) starts with an empty edge cache.
            "Cache-Control": "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400",
        },
    });
}
