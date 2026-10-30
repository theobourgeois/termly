import { getCourse } from "@/lib/data";
import { requestedUniversity } from "@/lib/university";

export async function GET(request: Request, { params }: { params: Promise<{ course: string }> }) {
  const university = requestedUniversity(request);
  const course = university ? await getCourse(university, (await params).course) : undefined;

  if (!course) {
    return new Response('Course not found', { status: 404 });
  }

  return new Response(JSON.stringify(course), {
    headers: {
      'Content-Type': 'application/json',
      // Cached at Vercel's edge so adding a course doesn't wait on a server loading the catalog.
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
