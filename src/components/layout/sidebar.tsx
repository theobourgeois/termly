"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
    BuildingsIcon,
    CalendarBlankIcon,
    CompassIcon,
    HouseIcon,
    MagnifyingGlassIcon,
    UsersIcon,
    WarningCircleIcon,
    type Icon,
} from "@phosphor-icons/react";
import { usePlannedTerm, useTerms } from "@/components/current-term";
import { useCourseIndex } from "@/components/search/course-index";
import { useSearchDialog } from "@/components/search/search-dialog";
import { useHref, useUniversity } from "@/components/university";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Dot } from "@/components/ui/status";
import { useTermSchedule } from "@/hooks/use-term-schedule";
import { displayName, useUser } from "@/hooks/use-user";
import { type Term } from "@/lib/constants";
import { formatCourseCode, totalCredits } from "@/lib/schedule";
import type { CourseAndSubjectCode } from "@/lib/types";
import { splitUniversityPath } from "@/lib/university";
import { cn } from "@/lib/utils";
import { useLibraryStore, useLibraryStoreApi } from "@/store/library-store";
import { useScheduleStore, useScheduleStoreApi } from "@/store/schedule-store";
import { useHydrated } from "@/store/storage";
import { ThemeToggle } from "./theme-toggle";
import { UniversitySwitcher } from "./university-switcher";

/** "/CSCI2110": letters then a code with a digit, unlike any page name. */
const isCoursePath = (path: string) => /^\/[A-Z]+\d[A-Z0-9]*$/i.test(path);

const navItems: { href: string; label: string; icon: Icon; isActive: (path: string) => boolean }[] = [
    { href: "/", label: "Home", icon: HouseIcon, isActive: (path) => path === "/" },
    {
        href: "/explore",
        label: "Explore",
        icon: CompassIcon,
        isActive: (path) => path.startsWith("/explore") || isCoursePath(path),
    },
    { href: "/schedule", label: "Schedule", icon: CalendarBlankIcon, isActive: (path) => path.startsWith("/schedule") },
    { href: "/rooms", label: "Rooms", icon: BuildingsIcon, isActive: (path) => path.startsWith("/rooms") },
    {
        href: "/instructors",
        label: "Instructors",
        icon: UsersIcon,
        isActive: (path) => path.startsWith("/instructors"),
    },
];

function SectionHeading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
    return (
        <div className="mx-3.5 mb-1.5 mt-6 flex items-center justify-between text-[13px] font-bold text-fg-subtle">
            <span>{children}</span>
            {aside && <span className="font-medium">{aside}</span>}
        </div>
    );
}

const rowClass = "flex h-[34px] items-center gap-2.5 rounded-full px-3.5 text-sm transition-colors hover:bg-raised";

function CourseLink({
    code,
    color,
    warn,
    onNavigate,
}: {
    code: CourseAndSubjectCode;
    color: string;
    warn?: boolean;
    onNavigate?: () => void;
}) {
    const { byCode } = useCourseIndex();
    const pagePath = useHref();
    return (
        <Link href={pagePath(`/${code}`)} onClick={onNavigate} className={rowClass}>
            <Dot color={color} />
            <span className="shrink-0 font-bold">{formatCourseCode(code)}</span>
            <span className="min-w-0 truncate font-medium text-fg-subtle">{byCode.get(code)?.title}</span>
            {warn && (
                <WarningCircleIcon
                    weight="fill"
                    className="ml-auto size-4 shrink-0 text-danger"
                    aria-label="Clashes with another course"
                />
            )}
        </Link>
    );
}

function ScheduleSection({ onNavigate }: { onNavigate?: () => void }) {
    const { label: termLabel } = useTerms();
    const { creditLabel } = useUniversity();
    const { ready, term, codes, colors, conflicted, credits } = useTermSchedule();
    if (!ready) return null;

    return (
        <>
            <SectionHeading aside={codes.length > 0 && credits !== null && `${credits} ${creditLabel.toLowerCase()}`}>
                {termLabel(term)}
            </SectionHeading>
            {codes.length === 0 ? (
                <p className="mx-3.5 text-[13px] text-fg-subtle">Courses you add will show up here.</p>
            ) : (
                codes.map((code) => (
                    <CourseLink
                        key={code}
                        code={code}
                        color={colors[code]}
                        warn={conflicted.has(code)}
                        onNavigate={onNavigate}
                    />
                ))
            )}
        </>
    );
}

function SavedSection({ onNavigate }: { onNavigate?: () => void }) {
    const saved = useLibraryStore((state) => state.saved);
    const ready = useHydrated(useLibraryStoreApi());
    if (!ready || saved.length === 0) return null;

    return (
        <>
            <SectionHeading>Saved</SectionHeading>
            {saved.map((code) => (
                <CourseLink key={code} code={code} color="rgb(var(--fg-subtle))" onNavigate={onNavigate} />
            ))}
        </>
    );
}

function OtherTermsSection({ onNavigate }: { onNavigate?: () => void }) {
    const { label: termLabel, listed: termCodes } = useTerms();
    const { creditLabel } = useUniversity();
    const pagePath = useHref();
    const router = useRouter();
    const { byCode, loaded } = useCourseIndex();
    const plannedTerm = usePlannedTerm();
    const sessions = useScheduleStore((state) => state.sessions);
    const setTerm = useScheduleStore((state) => state.setTerm);
    const ready = useHydrated(useScheduleStoreApi());
    if (!ready) return null;

    /** "9 credits", "Empty", or nothing while the course index (which has each course's credits) loads. */
    const summaryOf = (term: Term) => {
        const inTerm = sessions.filter((session) => session.term === term);
        if (inTerm.length === 0) return "Empty";
        if (!loaded) return null;
        const credits = totalCredits(inTerm, (code) => byCode.get(code)?.creditHours);
        return credits > 0 ? `${credits} ${creditLabel.toLowerCase()}` : "Empty";
    };

    const openTerm = (term: Term) => {
        setTerm(term);
        onNavigate?.();
        router.push(pagePath("/schedule"));
    };

    return (
        <>
            <SectionHeading>Other terms</SectionHeading>
            {termCodes
                .filter((term) => term !== plannedTerm)
                .map((term) => (
                    <button
                        key={term}
                        type="button"
                        onClick={() => openTerm(term)}
                        // Some names are long ("Summer 2026 (May-August, graduate)"), so the row grows to fit them.
                        className={cn(
                            rowClass,
                            "h-auto min-h-[34px] w-full justify-between gap-3 py-1.5 text-left text-fg-muted",
                        )}
                    >
                        <span className="min-w-0 font-medium leading-snug">{termLabel(term)}</span>
                        <span className="shrink-0 text-[13px] text-fg-subtle">{summaryOf(term)}</span>
                    </button>
                ))}
        </>
    );
}

function Account() {
    const user = useUser();
    const pagePath = useHref();
    if (user === undefined) return <div className="h-9" />;

    if (!user) {
        return (
            <Button asChild variant="outline" size="sm">
                <Link href={pagePath("/auth/login")}>Sign in</Link>
            </Button>
        );
    }

    const name = displayName(user);
    return (
        <Link href={pagePath("/protected")} className="flex min-w-0 items-center gap-2.5 rounded-full">
            <Avatar name={name} className="size-8" />
            <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-bold">{name}</span>
                <span className="block text-xs font-medium text-fg-subtle">Account</span>
            </span>
        </Link>
    );
}

/** Sidebar contents, shared by the desktop sidebar and the mobile menu. */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
    const { path } = splitUniversityPath(usePathname());
    const pagePath = useHref();
    const { openSearch } = useSearchDialog();

    return (
        <div className="flex h-full flex-col px-3 pb-3 pt-4">
            <UniversitySwitcher onNavigate={onNavigate} className="self-start" />

            <button
                type="button"
                onClick={() => {
                    onNavigate?.();
                    openSearch();
                }}
                className="mb-2.5 mt-4 flex h-[38px] items-center gap-2 rounded-full border border-line-strong px-3.5 text-sm font-medium text-fg-subtle transition-colors hover:text-fg-muted"
            >
                <MagnifyingGlassIcon className="size-4" />
                Search
                <Kbd className="ml-auto h-5 min-w-5 px-1.5">/</Kbd>
            </button>

            <nav className="flex flex-col gap-0.5" aria-label="Main">
                {navItems.map(({ href, label, icon: NavIcon, isActive }) => {
                    const active = isActive(path);
                    return (
                        <Link
                            key={href}
                            href={pagePath(href)}
                            onClick={onNavigate}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                "flex h-[38px] items-center gap-3 rounded-full px-3.5 text-[15px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg",
                                active &&
                                    "bg-panel font-bold text-fg shadow-[0_0_0_1px_var(--line)] hover:bg-panel dark:bg-raised",
                            )}
                        >
                            <NavIcon weight={active ? "fill" : "regular"} className="size-[18px]" />
                            {label}
                        </Link>
                    );
                })}
            </nav>

            <div className="-mx-1 mt-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2 [scrollbar-width:thin]">
                <ScheduleSection onNavigate={onNavigate} />
                <SavedSection onNavigate={onNavigate} />
                <OtherTermsSection onNavigate={onNavigate} />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line px-2 pt-3">
                <Account />
                <ThemeToggle />
            </div>
        </div>
    );
}
