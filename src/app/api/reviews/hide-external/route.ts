import { revalidatePath, revalidateTag } from "next/cache";
import { courseContentTag } from "@/lib/course-content";
import { universityPath } from "@/lib/university";
import { NextResponse } from "next/server";
import { getSession, isModerator } from "@/lib/auth";

/** Hides a RateMyProfessors review from everyone but moderators and clears its reports. */
export async function POST(req: Request) {
  const session = await getSession();

  if (!session || !isModerator(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { external_review_id } = await req.json();

  if (!external_review_id) {
    return NextResponse.json({ error: "external_review_id is required" }, { status: 400 });
  }

  const { data, error } = await session.supabase
    .from("external_reviews")
    .update({ hidden_at: new Date().toISOString() })
    .eq("id", external_review_id)
    .select("university_id, course_code");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (data.length === 0) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  await session.supabase.from("external_review_flags").delete().eq("external_review_id", external_review_id);

  // Course pages are cached for a day; drop this one so the review goes away now.
  // The page is rendered at /<university>/<code>; Dal's is also served at /<code>.
  const { university_id, course_code } = data[0];
  // Course pages read reviews from a file; this makes them check for reviews hidden since.
  revalidateTag(courseContentTag(university_id));
  revalidatePath(`/${university_id}/${course_code}`);
  revalidatePath(universityPath(university_id, `/${course_code}`));

  return NextResponse.json({ message: "Review hidden" }, { status: 200 });
}
