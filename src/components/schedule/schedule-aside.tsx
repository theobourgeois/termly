"use client";

import Link from "next/link";
import { XIcon } from "@phosphor-icons/react";
import { AsideDivider, AsideHeading } from "@/components/layout/page";
import { useCourseIndex } from "@/components/search/course-index";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Property, PropertyList } from "@/components/ui/property-list";
import { Dot } from "@/components/ui/status";
import type { TermSchedule } from "@/hooks/use-term-schedule";
import { dayNames } from "@/lib/constants";
import { findExam, formatExam, type ExamSchedule } from "@/lib/exams";
import { formatCourseCode, listSessions, weekShape } from "@/lib/schedule";
import { formatDays, formatDuration, formatMinutes, weeklyMinutes } from "@/lib/time";
import { useScheduleStore } from "@/store/schedule-store";
import { useHref, useUniversity } from "@/components/university";

type ScheduleAsideProps = {
    schedule: TermSchedule;
    exams: ExamSchedule;
};

/** The details column on the schedule page: courses, CRNs, the shape of the week and final exams. */
export function ScheduleAside({ schedule, exams }: ScheduleAsideProps) {
    const pagePath = useHref();
    const { byCode } = useCourseIndex();
    const { timezone } = useUniversity();
    const removeCourse = useScheduleStore((state) => state.removeCourse);
    const { term, codes, colors, sessions, conflicts } = schedule;
    const shape = weekShape(sessions);
    const sessionsOf = (code: string) => sessions.filter((session) => session.course === code);
    const clashPartner = (code: string) => {
        const conflict = conflicts.find(({ first, second }) => first.course === code || second.course === code);
        if (!conflict) return undefined;
        return conflict.first.course === code ? conflict.second.course : conflict.first.course;
    };
    const examRows = codes.flatMap((code) => {
        const exam = findExam(exams[term]?.[code], sessionsOf(code));
        return exam ? [{ code, exam }] : [];
    });

    return (
        <>
            <AsideHeading>Courses</AsideHeading>
            <ul className="flex flex-col gap-1">
                {codes.map((code) => {
                    const partner = clashPartner(code);
                    return (
                        <li key={code} className="group grid grid-cols-[0.625rem_1fr_auto] gap-3 py-2">
                            <Dot color={colors[code]} className="mt-[7px]" />
                            <div className="min-w-0">
                                <Link
                                    href={pagePath(`/${code}`)}
                                    className="flex justify-between text-[14.5px] font-bold hover:underline"
                                >
                                    {formatCourseCode(code)}
                                    {byCode.has(code) && (
                                        <span className="text-[13.5px] font-medium text-fg-subtle">
                                            {byCode.get(code)!.creditHours} cr
                                        </span>
                                    )}
                                </Link>
                                <p className="truncate text-[13.5px] font-medium text-fg-muted">
                                    {byCode.get(code)?.title}
                                </p>
                                <p
                                    className={
                                        partner ? "text-[13px] font-medium text-danger" : "text-[13px] text-fg-subtle"
                                    }
                                >
                                    {partner
                                        ? `Clashes with ${formatCourseCode(partner)}`
                                        : listSessions(sessionsOf(code))}
                                </p>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove ${formatCourseCode(code)}`}
                                className="md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100"
                                onClick={() => removeCourse(code, term)}
                            >
                                <XIcon />
                            </Button>
                        </li>
                    );
                })}
            </ul>
            <CopyButton className="mt-3 w-full" text={sessions.map((session) => session.crn).join(", ")}>
                Copy CRNs for registration
            </CopyButton>

            {shape && (
                <>
                    <AsideDivider />
                    <PropertyList>
                        <Property label="Class time">{formatDuration(weeklyMinutes(sessions))} a week</Property>
                        <Property label="Earliest start">
                            <span>{formatMinutes(shape.earliest)}</span>{" "}
                            <span className="text-fg-subtle">{formatDays(shape.earliestDays)}</span>
                        </Property>
                        <Property label="Busiest day">
                            {dayNames[shape.busiestDay].long}{" "}
                            <span className="text-fg-subtle">{shape.busiestCount} classes</span>
                        </Property>
                    </PropertyList>
                </>
            )}

            {examRows.length > 0 && (
                <>
                    <AsideDivider />
                    <AsideHeading>Final exams</AsideHeading>
                    <ul className="flex flex-col gap-1.5 text-sm">
                        {examRows.map(({ code, exam }) => (
                            <li key={code} className="flex justify-between gap-3">
                                <span className="font-bold">{formatCourseCode(code)}</span>
                                <span className="font-medium text-fg-muted">{formatExam(exam, timezone)}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </>
    );
}
