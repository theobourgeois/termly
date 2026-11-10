"use client";

import { useTerms } from "@/components/current-term";
import { SITE_NAME } from "@/lib/constants";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EyeSlashIcon, FlagIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useCourse } from "@/components/course/course-context";
import { SectionHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShowMore } from "@/components/ui/show-more";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { usePaged } from "@/hooks/use-paged";
import { useIsModerator, useUser } from "@/hooks/use-user";
import { formatReviewDate } from "@/lib/reviews";
import { RMP_PREVIEW_SIZE, rmpAverages, type RmpAverages, type RmpReview } from "@/lib/rmp-reviews";
import { isSameInstructor } from "@/lib/syllabi";
import { useReviews } from "./reviews-context";
import { useHref } from "@/components/university";

// The reviews sent with the page are exactly the first page shown.
const PAGE_SIZE = RMP_PREVIEW_SIZE;
const NO_SCORES = rmpAverages([]);
const ALL = "__all";

/** Average quality and difficulty, and how many would take the professor again, shown large. */
export function RmpScoresSummary({ averages }: { averages: RmpAverages }) {
    const { quality, difficulty, takeAgain } = averages;
    const scores = [
        quality !== null && { value: quality.toFixed(1), label: "quality" },
        difficulty !== null && { value: difficulty.toFixed(1), label: "difficulty" },
        takeAgain !== null && { value: `${takeAgain}%`, label: "would take again" },
    ].filter((score) => score !== false);

    return (
        <div className="flex flex-wrap items-baseline gap-x-9 gap-y-2">
            {scores.map(({ value, label }) => (
                <span key={label} className="flex items-baseline gap-2">
                    <span className="text-3xl font-black tracking-tight">{value}</span>
                    <span className="text-sm font-medium text-fg-muted">{label}</span>
                </span>
            ))}
        </div>
    );
}

async function postReview(url: string, review: RmpReview) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ external_review_id: review.id }),
    });
    return response.ok;
}

/** Hides a RateMyProfessors review for everyone; moderators only. */
export async function hideRmpReview(review: RmpReview): Promise<boolean> {
    if (!window.confirm(`Hide this review on ${SITE_NAME} for everyone?`)) return false;
    const ok = await postReview("/api/reviews/hide-external", review);
    toast(ok ? "Review hidden" : "Couldn't hide this review. Try again later.");
    return ok;
}

type RmpReviewActionsProps = {
    review: RmpReview;
    signedIn: boolean;
    isModerator: boolean;
    onHidden: () => void;
};

/** Report for students, Hide for moderators. */
function RmpReviewActions({ review, signedIn, isModerator, onHidden }: RmpReviewActionsProps) {
    const pagePath = useHref();
    const router = useRouter();

    const report = async () => {
        if (!signedIn) {
            toast("Sign in to report reviews", {
                action: { label: "Sign in", onClick: () => router.push(pagePath("/auth/login")) },
            });
            return;
        }
        if (!window.confirm("Report this review to the moderators?")) return;
        const ok = await postReview("/api/flags/add", review);
        toast(ok ? "Thanks, a moderator will take a look" : "Couldn't report this review. Try again later.");
    };

    return isModerator ? (
        <SimpleTooltip label={`Hide on ${SITE_NAME}`}>
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Hide review"
                onClick={async () => (await hideRmpReview(review)) && onHidden()}
            >
                <EyeSlashIcon />
            </Button>
        </SimpleTooltip>
    ) : (
        <SimpleTooltip label="Report">
            <Button variant="ghost" size="icon-sm" aria-label="Report review" onClick={report}>
                <FlagIcon />
            </Button>
        </SimpleTooltip>
    );
}

type RmpReviewItemProps = {
    review: RmpReview;
    /** Shown first, e.g. a course code link in the moderation panel. */
    context?: React.ReactNode;
    actions?: React.ReactNode;
};

export function RmpReviewItem({ review, context, actions }: RmpReviewItemProps) {
    const details = [
        review.quality !== null && `Quality ${review.quality}`,
        review.difficulty !== null && `Difficulty ${review.difficulty}`,
        review.grade && `Grade ${review.grade}`,
        review.would_take_again !== null && (review.would_take_again ? "Would take again" : "Wouldn't take again"),
    ].filter(Boolean);

    return (
        <article className="border-b border-line py-5 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                {context && <span className="text-[15px] font-bold">{context}</span>}
                <span className="text-[15px] font-medium text-fg-muted">
                    Taught by{" "}
                    {review.instructor_url ? (
                        <a
                            href={review.instructor_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-bold text-fg hover:underline"
                        >
                            {review.instructor}
                        </a>
                    ) : (
                        <span className="font-bold text-fg">{review.instructor}</span>
                    )}
                </span>
                <span className="text-[13px] text-fg-subtle">
                    {formatReviewDate(review.reviewed_at)}
                    {review.online && ", online"}
                </span>
                {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
            </div>
            {review.review_text && (
                <p className="mt-1.5 max-w-[42rem] whitespace-pre-wrap text-[15px] font-medium leading-relaxed text-fg-body">
                    {review.review_text}
                </p>
            )}
            {(details.length > 0 || review.tags.length > 0) && (
                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-subtle">
                    {details.map((detail) => (
                        <span key={String(detail)}>{detail}</span>
                    ))}
                    {review.tags.length > 0 && <span>{review.tags.join(", ")}</span>}
                </div>
            )}
        </article>
    );
}

/** RateMyProfessors reviews that mention this course, below the site's own reviews on the Reviews tab. */
export function RmpReviews() {
    const { label: termLabel } = useTerms();
    const { rmpReviews, rmpSummary, rmpComplete, loadRmpReviews, removeRmpReview } = useReviews();
    const { course, term } = useCourse();
    const [instructor, setInstructor] = useState(ALL);
    const signedIn = Boolean(useUser());
    const isModerator = useIsModerator();
    const shown = instructor === ALL ? rmpReviews : rmpReviews.filter((review) => review.instructor === instructor);
    const page = usePaged(shown, PAGE_SIZE);

    // Only the first page came with the course page; this tab is where the rest are read.
    useEffect(() => {
        if (!rmpComplete) void loadRmpReviews();
    }, [rmpComplete, loadRmpReviews]);

    if (rmpSummary.total === 0 || !rmpSummary.years) return null;

    // People teaching the term on the page come first, then whoever has the most reviews.
    const teaching = course.instructorsByTerm[term] ?? [];
    const reviewed = new Map(rmpSummary.instructors.map((entry) => [entry.name, entry]));
    const isTeaching = (name: string) => teaching.some((current) => isSameInstructor(current, name));
    const instructors = [...reviewed.keys()].sort(
        (a, b) => Number(isTeaching(b)) - Number(isTeaching(a)) || reviewed.get(b)!.count - reviewed.get(a)!.count,
    );
    const { newest, oldest } = rmpSummary.years;
    // Counted from the summary, so "Show more" is there (and retries) while the rest are still loading.
    const expected = instructor === ALL ? rmpSummary.total : (reviewed.get(instructor)?.count ?? 0);
    const more = Math.min(PAGE_SIZE, Math.max(0, expected - page.visible.length));

    return (
        <section className="mt-12">
            <SectionHeader title="From RateMyProfessors">
                {instructors.length > 1 && (
                    <Select
                        value={instructor}
                        onValueChange={(name) => {
                            setInstructor(name);
                            page.reset();
                        }}
                    >
                        <SelectTrigger aria-label="Filter by instructor" className="h-9 w-auto min-w-48 rounded-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                            <SelectItem value={ALL}>All instructors</SelectItem>
                            {instructors.map((name) => (
                                <SelectItem key={name} value={name}>
                                    {name} ({reviewed.get(name)!.count}){isTeaching(name) && `, teaching ${termLabel(term)}`}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </SectionHeader>
            <p className="mt-1.5 max-w-[42rem] text-[13px] text-fg-subtle">
                {rmpSummary.total} {rmpSummary.total === 1 ? "review" : "reviews"}
                {oldest === newest ? ` from ${newest}` : ` from ${oldest} to ${newest}`} that name this course. Quality
                rates the professor, not the course.
            </p>
            <div className="mt-5">
                <RmpScoresSummary
                    averages={
                        instructor === ALL ? rmpSummary.averages : (reviewed.get(instructor)?.averages ?? NO_SCORES)
                    }
                />
            </div>
            <div className="mt-3">
                {page.visible.map((review) => (
                    <RmpReviewItem
                        key={review.id}
                        review={review}
                        actions={
                            <RmpReviewActions
                                review={review}
                                signedIn={signedIn}
                                isModerator={isModerator}
                                onHidden={() => removeRmpReview(review.id)}
                            />
                        }
                    />
                ))}
            </div>
            <ShowMore
                className="mt-2 justify-start"
                count={more}
                onClick={() => {
                    page.showMore();
                    if (!rmpComplete) void loadRmpReviews();
                }}
            />
        </section>
    );
}
