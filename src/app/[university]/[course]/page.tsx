import type { Metadata } from "next";
import { SITE_URL } from "@/lib/constants";
import { snippet, universityPageMetadata } from "@/lib/seo";
import { notFound } from "next/navigation";
import { CourseActions } from "@/components/course/course-actions";
import { CourseProvider } from "@/components/course/course-context";
import { CourseDetails } from "@/components/course/course-details";
import { CourseSyllabus } from "@/components/course/course-syllabus";
import { CourseTabs } from "@/components/course/course-tabs";
import { CourseWeek } from "@/components/course/course-week";
import { RecordRecentCourse } from "@/components/course/record-recent-course";
import { ReviewsSummary } from "@/components/course/reviews-summary";
import { SectionsTable } from "@/components/course/sections-table";
import { Page, PageHeader } from "@/components/layout/page";
import { CourseReviews } from "@/components/reviews/course-reviews";
import { ReviewsProvider } from "@/components/reviews/reviews-context";
import { RmpReviews } from "@/components/reviews/rmp-reviews";
import { getRmpReviews, getSyllabi } from "@/lib/course-content";
import { defaultCourseTerm, offeredTerms } from "@/lib/course";
import {
    getCourse,
    getCourseInstructors,
    getCurrentTerm,
    getListedTerms,
    getRatingSummaries,
    getSubjects,
    getUnlockedCourses,
    toListItem,
} from "@/lib/data";
import { courseKey, formatCourseCode } from "@/lib/schedule";
import { getUniversity, universityPath } from "@/lib/university";

type Props = { params: Promise<{ university: string; course: string }> };

/**
 * No course is built ahead; each renders on its first visit and is cached from then on (revalidated
 * daily, and when a moderator changes its reviews or syllabi). Without this the page renders on every
 * request, loading the whole catalog on whichever server instance gets it.
 */
export function generateStaticParams() {
    return [];
}

/** A first visit on a fresh server instance loads the university's catalog, which can take a while. */
export const maxDuration = 60;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { university, course: code } = await params;
    const course = await getCourse(university, code);
    if (!course) return { title: "Course not found", robots: { index: false } };
    const { name, shortName } = getUniversity(university)!;
    const label = `${formatCourseCode(courseKey(course))} ${course.title}`;

    return universityPageMetadata(university, `/${courseKey(course)}`, {
        title: `${label} - ${name}`,
        description: snippet(
            course.description
                ? `${label} at ${shortName}: ${course.description}`
                : `${label} at ${name}: sections, open seats, instructors and their ratings, and when it's offered.`,
        ),
    });
}

export default async function CoursePage({ params }: Props) {
    const { university, course: requested } = await params;
    const course = await getCourse(university, requested);
    if (!course) notFound();

    const code = courseKey(course);
    const instructors = getCourseInstructors(course);
    const [rmpReviews, syllabi, listed, currentTerm, subjects, unlocks, ratings] = await Promise.all([
        getRmpReviews(university, code),
        getSyllabi(university, code),
        getListedTerms(university),
        getCurrentTerm(university),
        getSubjects(university),
        getUnlockedCourses(university, code),
        getRatingSummaries(university, instructors),
    ]);
    const offered = offeredTerms(course, listed);
    const subject = subjects.find((s) => s.code === course.subjectCode);
    const description = course.description;

    const school = getUniversity(university)!;
    const structuredData = [
        {
            "@context": "https://schema.org",
            "@type": "Course",
            name: `${formatCourseCode(code)} ${course.title}`,
            courseCode: formatCourseCode(code),
            description: description || undefined,
            url: `${SITE_URL}${universityPath(university, `/${code}`)}`,
            provider: { "@type": "CollegeOrUniversity", name: school.name },
            ...(course.prerequisites.length > 0 && {
                coursePrerequisites: course.prerequisites.map(formatCourseCode).join(", "),
            }),
        },
        {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
                { name: school.name, path: "/" },
                { name: "Explore", path: "/explore" },
                { name: formatCourseCode(code), path: `/${code}` },
            ].map((crumb, index) => ({
                "@type": "ListItem",
                position: index + 1,
                name: crumb.name,
                item: `${SITE_URL}${universityPath(university, crumb.path)}`,
            })),
        },
    ];

    return (
        <Page
            breadcrumbs={[
                { label: "Explore", href: universityPath(university, "/explore") },
                ...(subject
                    ? [{ label: subject.name, href: universityPath(university, `/explore?subject=${subject.code}`) }]
                    : []),
                { label: formatCourseCode(code) },
            ]}
        >
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }}
            />
            <RecordRecentCourse code={code} />

            <CourseProvider
                course={toListItem(course)}
                offered={offered}
                initialTerm={defaultCourseTerm(offered, currentTerm, listed)}
            >
                <ReviewsProvider courseId={code} instructors={instructors} rmpReviews={rmpReviews}>
                    <PageHeader title={formatCourseCode(code)} subtitle={course.title} />
                    <CourseActions title={`${formatCourseCode(code)} ${course.title}`} />
                    <CourseTabs
                        overview={
                            <>
                                {description && (
                                    <p className="max-w-[42rem] text-[15.5px] font-medium leading-relaxed text-fg-body">
                                        {description}
                                    </p>
                                )}
                                <SectionsTable />
                                <CourseSyllabus syllabi={syllabi} />
                                <ReviewsSummary />
                            </>
                        }
                        schedule={<CourseWeek />}
                        reviews={
                            <>
                                <CourseReviews />
                                <RmpReviews />
                            </>
                        }
                        aside={
                            <CourseDetails
                                prerequisites={course.prerequisites}
                                unlocks={unlocks.map((summary) => summary.code)}
                                ratings={ratings}
                            />
                        }
                    />
                </ReviewsProvider>
            </CourseProvider>
        </Page>
    );
}
