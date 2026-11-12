import { revalidatePath, revalidateTag } from "next/cache";
import { courseContentTag } from "@/lib/course-content";
import { NextResponse } from "next/server";
import { getSession, isModerator } from "@/lib/auth";
import { adminClient } from "@/lib/supabase/admin";
import { normalizeCode, SYLLABUS_MODEL, weightsAddUp, type SyllabusDetails } from "@/lib/syllabus-extraction";
import { universityPath } from "@/lib/university";

/**
 * A moderator's decision on an uploaded syllabus ({ id, action: "approve" | "reject", reason? }).
 * Approving publishes what the model read as a syllabus on the course page (and any cross-listed
 * course); rejecting deletes the file.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !isModerator(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, action, reason } = await request.json();
  if (typeof id !== "string" || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "Send id and action" }, { status: 400 });
  }

  const admin = adminClient();
  const { data: upload } = await admin.from("syllabus_uploads").select("*").eq("id", id).eq("status", "pending").single();
  if (!upload) return NextResponse.json({ error: "No pending upload with that id" }, { status: 404 });
  const reviewed = { reviewed_by: session.user.id, reviewed_at: new Date().toISOString() };

  if (action === "reject") {
    await admin.storage.from("syllabus-uploads").remove([upload.file_path]);
    const { error } = await admin
      .from("syllabus_uploads")
      .update({ status: "rejected", rejection_reason: typeof reason === "string" ? reason.slice(0, 500) : null, ...reviewed })
      .eq("id", id);
    return error ? NextResponse.json({ error: error.message }, { status: 500 }) : NextResponse.json({ ok: true });
  }

  const details = upload.details as SyllabusDetails;
  // The upload's course, plus cross-listings the syllabus names that the university offers.
  const named = [...new Set(details.course_codes.map(normalizeCode))].filter((code) => code !== upload.course_code);
  const { data: crossListed } = named.length
    ? await admin.from("courses").select("code").eq("university_id", upload.university_id).in("code", named)
    : { data: [] };
  const courseCodes = [upload.course_code, ...(crossListed ?? []).map((row) => row.code)];

  const { error } = await admin.from("syllabi").insert({
    university_id: upload.university_id,
    upload_id: upload.id,
    source_url: null,
    archived: false,
    course_codes: courseCodes,
    term_season: details.term_season,
    term_year: details.term_year ?? new Date(upload.created_at).getFullYear(),
    instructors: details.instructors,
    grading_schemes: details.grading_schemes,
    weights_add_up: weightsAddUp(details),
    textbooks: details.textbooks,
    policies: details.policies,
    weekly_topics: details.weekly_topics,
    class_meetings: details.class_meetings,
    model: SYLLABUS_MODEL,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("syllabus_uploads").update({ status: "approved", ...reviewed }).eq("id", id);
  // Course pages read syllabi from a file; this makes them check for ones published since.
  revalidateTag(courseContentTag(upload.university_id));
  for (const code of courseCodes) {
    revalidatePath(`/${upload.university_id}/${code}`);
    revalidatePath(universityPath(upload.university_id, `/${code}`));
  }
  return NextResponse.json({ ok: true });
}
