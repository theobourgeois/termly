"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { CaretDownIcon, DotsThreeIcon, ExportIcon, PlusIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { CalendarTabs, type CalendarView } from "@/components/calendar/calendar-tabs";
import { useCurrentTerm, useTerms } from "@/components/current-term";
import { useCourseIndex } from "@/components/search/course-index";
import { PageActions, PageHeader } from "@/components/layout/page";
import { useSearchDialog } from "@/components/search/search-dialog";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { useCampusNow } from "@/hooks/use-campus-now";
import { useTermSchedule } from "@/hooks/use-term-schedule";
import { conflictingMeetings, sessionEvents } from "@/lib/calendar";
import { type Term } from "@/lib/constants";
import type { ExamSchedule } from "@/lib/exams";
import { formatCourseCode, sessionName } from "@/lib/schedule";
import { exportFormatLabels, exportFormats, exportSchedule, type ExportFormat } from "@/lib/schedule-export";
import { formatTimeRange } from "@/lib/time";
import { plural } from "@/lib/utils";
import { useScheduleStore } from "@/store/schedule-store";
import { CalendarSync } from "./calendar-sync";
import { ConflictNotice } from "./conflict-notice";
import { ScheduleAside } from "./schedule-aside";
import { useHref, useUniversity } from "@/components/university";

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function TermSwitcher({ term }: { term: Term }) {
    const { options: termOptions } = useTerms();
    const setTerm = useScheduleStore((state) => state.setTerm);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" aria-label="Switch term">
                    <CaretDownIcon />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={term} onValueChange={(value) => setTerm(value as Term)}>
                    {termOptions().map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value}>
                            {option.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The schedule for the term being planned: week calendar or list, clashes, and course details. */
export function ScheduleView({ exams }: { exams: ExamSchedule }) {
    const pagePath = useHref();
    const { label: termLabel, terms } = useTerms();
    const university = useUniversity();
    const { creditLabel } = university;
    const { byCode } = useCourseIndex();
    const schedule = useTermSchedule();
    const { term, sessions, codes, colors, conflicts, credits, ready } = schedule;
    const currentTerm = useCurrentTerm();
    const clearTerm = useScheduleStore((state) => state.clearTerm);
    const { openSearch } = useSearchDialog();
    const calendarRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<CalendarView>("week");
    const now = useCampusNow();
    const conflicted = conflictingMeetings(conflicts);

    const events = sessions.flatMap((session) =>
        sessionEvents(session, (timed, id) => ({
            title: formatCourseCode(session.course),
            lines: [sessionName(session), formatTimeRange(timed), session.location],
            variant: "tinted",
            color: colors[session.course],
            conflict: conflicted.has(id),
            href: pagePath(`/${session.course}`),
        })),
    );

    /** Images are taken of the week calendar, so switch to it first when the list is showing. */
    const exportAs = async (format: ExportFormat) => {
        try {
            if (format !== "ics" && view !== "week") {
                setView("week");
                await nextFrame();
            }
            await exportSchedule(format, calendarRef.current, {
                university,
                sessions,
                terms,
                exams,
                titleOf: (code) => byCode.get(code)?.title,
                origin: window.location.origin,
            });
        } catch {
            toast("Couldn't export your schedule. Try another format.");
        }
    };

    const header = (
        <>
            <PageHeader
                title={termLabel(term)}
                titleAddon={<TermSwitcher term={term} />}
                subtitle={
                    ready && codes.length > 0
                        ? [plural(codes.length, "course"), credits !== null && `${credits} ${creditLabel.toLowerCase()}`]
                              .filter(Boolean)
                              .join(", ")
                        : undefined
                }
            />
            <PageActions
                trailing={
                    <>
                        <CalendarSync />
                        {codes.length > 0 && (
                            <>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon" aria-label="Export schedule">
                                            <ExportIcon />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent>
                                        <DropdownMenuLabel>Export as</DropdownMenuLabel>
                                        {exportFormats.map((format) => (
                                            <DropdownMenuItem key={format} onSelect={() => exportAs(format)}>
                                                {exportFormatLabels[format]}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="icon" aria-label="More">
                                            <DotsThreeIcon />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent>
                                        <DropdownMenuItem
                                            className="text-danger"
                                            onSelect={() =>
                                                window.confirm(`Remove every course from ${termLabel(term)}?`) &&
                                                clearTerm(term)
                                            }
                                        >
                                            Clear {termLabel(term)}
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </>
                        )}
                    </>
                }
            >
                <Button variant="primary" size="lg" onClick={openSearch}>
                    <PlusIcon weight="bold" />
                    Add a course
                </Button>
            </PageActions>
        </>
    );

    if (!ready) return header;

    if (codes.length === 0) {
        return (
            <>
                {header}
                <EmptyState
                    className="mt-8"
                    title={`Nothing in ${termLabel(term)} yet`}
                    description="Find a course, pick its sections and add it. It will show up here on your week."
                    action={
                        <Button asChild variant="outline">
                            <Link href={pagePath("/explore")}>Explore courses</Link>
                        </Button>
                    }
                />
            </>
        );
    }

    const [firstConflict] = conflicts;
    return (
        <>
            {header}
            <CalendarTabs
                ref={calendarRef}
                events={events}
                view={view}
                onViewChange={setView}
                now={term === currentTerm ? (now ?? undefined) : undefined}
                pxPerMinute={1.05}
                aside={<ScheduleAside schedule={schedule} exams={exams} />}
                header={
                    firstConflict && (
                        <ConflictNotice
                            conflicts={conflicts}
                            action={
                                <Button asChild size="sm" variant="outline">
                                    <Link href={pagePath(`/${firstConflict.second.course}`)}>Change sections</Link>
                                </Button>
                            }
                        />
                    )
                }
            />
        </>
    );
}
