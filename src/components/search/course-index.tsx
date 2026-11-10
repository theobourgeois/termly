"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useUniversity } from "@/components/university";
import type { CourseSummary } from "@/lib/types";

type CourseIndex = {
    courses: CourseSummary[];
    byCode: Map<string, CourseSummary>;
    /** False until the index arrives; until then no course has a title or credits to show. */
    loaded: boolean;
};

const CourseIndexContext = createContext<CourseIndex | null>(null);

const NONE: CourseSummary[] = [];
const RETRY_AFTER_MS = [2_000, 10_000];

const requests = new Map<string, Promise<CourseSummary[]>>();

/** A university's course index, fetched once per visit. */
function fetchCourseIndex(university: string): Promise<CourseSummary[]> {
    let request = requests.get(university);
    if (!request) {
        request = fetch(`/api/course-index?${new URLSearchParams({ university })}`).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json() as Promise<CourseSummary[]>;
        });
        // Forget failures so the next attempt asks again.
        request.catch(() => requests.delete(university));
        requests.set(university, request);
    }
    return request;
}

/**
 * Makes the lightweight course index (code, title, credits) available to client components. It's
 * fetched after the page loads rather than sent with it: a few thousand courses are about 300 KB, and
 * in the page they were stored and sent again with every one of a university's pages.
 */
export function CourseIndexProvider({ children }: { children: React.ReactNode }) {
    const { id: university } = useUniversity();
    const [index, setIndex] = useState<{ university: string; courses: CourseSummary[] } | null>(null);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const load = (attempt: number) => {
            fetchCourseIndex(university).then(
                (courses) => {
                    if (!cancelled) setIndex({ university, courses });
                },
                () => {
                    const delay = RETRY_AFTER_MS[attempt];
                    if (!cancelled && delay !== undefined) timer = setTimeout(() => load(attempt + 1), delay);
                },
            );
        };
        load(0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [university]);

    const value = useMemo(() => {
        const loaded = index?.university === university;
        const courses = loaded ? index.courses : NONE;
        return { courses, byCode: new Map(courses.map((course) => [course.code, course])), loaded };
    }, [index, university]);
    return <CourseIndexContext.Provider value={value}>{children}</CourseIndexContext.Provider>;
}

export function useCourseIndex(): CourseIndex {
    const index = useContext(CourseIndexContext);
    if (!index) throw new Error("useCourseIndex must be used inside CourseIndexProvider");
    return index;
}
