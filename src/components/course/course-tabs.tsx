"use client";

import { PageColumns } from "@/components/layout/page";
import { useReviews } from "@/components/reviews/reviews-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCourse, type CourseTab } from "./course-context";

type CourseTabsProps = Record<CourseTab, React.ReactNode> & { aside: React.ReactNode };

/** Overview / Schedule / Reviews, with the course details column beside every tab. */
export function CourseTabs({ overview, schedule, reviews, aside }: CourseTabsProps) {
    const { tab, setTab } = useCourse();
    const { reviews: list, status, rmpSummary } = useReviews();
    const reviewCount = (status === "ready" ? list.length : 0) + rmpSummary.total;

    return (
        <Tabs value={tab} onValueChange={(value) => setTab(value as CourseTab)} className="mt-8">
            <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="schedule">Schedule</TabsTrigger>
                <TabsTrigger value="reviews" count={status === "ready" || reviewCount > 0 ? reviewCount : undefined}>
                    Reviews
                </TabsTrigger>
            </TabsList>
            <PageColumns aside={aside}>
                <TabsContent value="overview">{overview}</TabsContent>
                <TabsContent value="schedule">{schedule}</TabsContent>
                <TabsContent value="reviews">{reviews}</TabsContent>
            </PageColumns>
        </Tabs>
    );
}
