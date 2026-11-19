import { revalidatePath } from "next/cache";
import { clearCatalog, getCourseIndex } from "@/lib/data";
import { getUniversity, universities, universityPath } from "@/lib/university";

/** A university's pages besides its courses'. The others (account, sign-in) don't show catalog data. */
const PAGES = ["/", "/explore", "/instructors", "/schedule", "/rooms"];

/**
 * Called by the data refresh workflow when it can't redeploy the site (no VERCEL_DEPLOY_HOOK), so
 * pages show new data straight away instead of within a week. Needs
 * `Authorization: Bearer <REVALIDATE_SECRET>`, and a body of `{ "universities": ["dal", ...] }` to
 * refresh only those universities' pages; without the list, every university's are.
 *
 * This only brings in data a deployment reads from Supabase: catalogs read from the files bundled
 * with the deployment stay as they were until the next deploy.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { universities?: unknown };
  const ids = Array.isArray(body.universities)
    ? body.universities.filter((id): id is string => typeof id === "string" && !!getUniversity(id))
    : universities.map(({ id }) => id);

  clearCatalog(ids);
  // Pages are cached by address: `/[university]` is a dynamic segment, so a university's layout
  // can't be revalidated on its own, only each of its pages.
  for (const id of ids) {
    const courses = await getCourseIndex(id).catch(() => []);
    for (const page of [...PAGES, ...courses.map(({ code }) => `/${code}`)]) {
      revalidatePath(universityPath(id, page));
    }
  }
  return Response.json({ revalidated: ids });
}
