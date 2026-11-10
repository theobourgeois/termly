"use client";

import { useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { TermsProvider, useTerms } from "@/components/current-term";
import { CourseIndexProvider } from "@/components/search/course-index";
import { SearchDialogProvider } from "@/components/search/search-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UniversityProvider, useUniversity } from "@/components/university";
import { fetchCourse } from "@/hooks/use-course-details";
import type { Term } from "@/lib/constants";
import type { TermInfo } from "@/lib/terms";
import { useLibraryStoreApi } from "@/store/library-store";
import { isLegacySession, useScheduleStoreApi } from "@/store/schedule-store";
import { ScheduleSync } from "@/store/schedule-sync";
import { useHydrated } from "@/store/storage";

/** Loads the university's persisted stores after the first render so server and client markup match. */
function StoreHydration() {
    const schedule = useScheduleStoreApi();
    const library = useLibraryStoreApi();
    useEffect(() => {
        void schedule.persist.rehydrate();
        void library.persist.rehydrate();
    }, [schedule, library]);
    return null;
}

/** Brings schedules saved before rooms were stored up to date, so they show readable rooms. */
function UpgradeSavedSchedule() {
    const { listed } = useTerms();
    const { id: university } = useUniversity();
    const schedule = useScheduleStoreApi();
    const ready = useHydrated(schedule);
    useEffect(() => {
        if (!ready) return;
        const legacy = schedule
            .getState()
            .sessions.filter((session) => isLegacySession(session) && listed.includes(session.term));
        const codes = [...new Set(legacy.map((session) => session.course))];
        if (codes.length === 0) return;
        void Promise.all(codes.map((code) => fetchCourse(university, code))).then((courses) =>
            schedule.getState().upgradeLegacySessions(courses.flatMap((course) => course?.termClasses ?? [])),
        );
    }, [ready, listed, schedule, university]);
    return null;
}

/** Site-wide: theme, tooltips and toasts. */
export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <TooltipProvider delayDuration={200}>
                {children}
                <Toaster />
            </TooltipProvider>
        </ThemeProvider>
    );
}

type UniversityProvidersProps = {
    university: string;
    terms: TermInfo[];
    currentTerm: Term;
    children: React.ReactNode;
};

/** Everything scoped to one university: its terms, courses, search and the student's saved data there. */
export function UniversityProviders({ university, terms, currentTerm, children }: UniversityProvidersProps) {
    return (
        <UniversityProvider id={university}>
            <TermsProvider terms={terms} current={currentTerm}>
                <CourseIndexProvider>
                    <SearchDialogProvider>
                        <StoreHydration />
                        <UpgradeSavedSchedule />
                        <ScheduleSync />
                        {children}
                    </SearchDialogProvider>
                </CourseIndexProvider>
            </TermsProvider>
        </UniversityProvider>
    );
}
