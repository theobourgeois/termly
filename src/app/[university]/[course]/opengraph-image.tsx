import { getCourse } from "@/lib/data";
import { ogImage, ogSize } from "@/lib/og-image";
import { courseKey, formatCourseCode } from "@/lib/schedule";
import { getUniversity } from "@/lib/university";

export const alt = "A course's sections, seats and instructors";
export const size = ogSize;
export const contentType = "image/png";

/** Rendered on first request and cached, like the course page. */
export function generateStaticParams() {
    return [];
}

export default async function Image({ params }: { params: Promise<{ university: string; course: string }> }) {
    const { university: id, course: code } = await params;
    const university = getUniversity(id)!;
    const course = await getCourse(id, code);
    return ogImage({
        title: course ? formatCourseCode(courseKey(course)) : formatCourseCode(code.toUpperCase()),
        subtitle: course?.title,
        university,
    });
}
