"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FlagIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ShowMore } from "@/components/ui/show-more";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { usePaged } from "@/hooks/use-paged";
import { displayName, useUser } from "@/hooks/use-user";
import { formatCourseCode } from "@/lib/schedule";
import { createClient } from "@/lib/supabase/client";
import type { Review } from "@/lib/reviews";
import { ConfirmUniversity } from "./confirm-university";
import { ReviewForm, type ReviewDraft } from "./review-form";
import { ReviewItem } from "./review-item";
import { ReviewScoresSummary } from "./review-summary";
import { useReviews } from "./reviews-context";
import { useHref, useUniversity } from "@/components/university";

const PAGE_SIZE = 6;
const ALL = "__all";

function Composer() {
    const { id: university } = useUniversity();
    const pagePath = useHref();
    const { courseId, instructors, reviews, refresh } = useReviews();
    const user = useUser();
    const isSignedIn = Boolean(user);
    const [open, setOpen] = useState(false);
    const alreadyReviewed = reviews.some((review) => review.user_id === user?.id);
    // Whether this student may review this university's courses: it's their school, or they've
    // confirmed an email there. Undefined until checked.
    const [canReview, setCanReview] = useState<boolean>();
    const userId = user?.id;

    useEffect(() => {
        if (!userId) return;
        let current = true;
        createClient()
            .rpc("can_review", { p_university: university })
            .then(({ data, error }) => {
                // On an error (say, before the database has this check) the posting rules still apply.
                if (current && !error) setCanReview(data === true);
            });
        return () => {
            current = false;
        };
    }, [userId, university]);

    if (alreadyReviewed) return null;

    if (isSignedIn && canReview === false) {
        return (
            <ConfirmUniversity
                onConfirmed={() => {
                    setCanReview(true);
                    setOpen(true);
                    toast("Confirmed. You can review these courses now.");
                }}
            />
        );
    }

    const post = async (draft: ReviewDraft) => {
        const { error } = await createClient()
            .from("reviews")
            .insert({ ...draft, university_id: university, course_code: courseId });
        if (error) return error.code === "23505" ? "You've already reviewed this course." : error.message;
        setOpen(false);
        toast("Thanks, your review is posted");
        await refresh();
        return null;
    };

    if (open && isSignedIn) {
        return (
            <div className="rounded-card border border-line-strong p-5">
                <ReviewForm
                    instructors={instructors}
                    submitLabel="Post review"
                    onSubmit={post}
                    onCancel={() => setOpen(false)}
                />
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3 rounded-full border border-line-strong py-2 pl-2.5 pr-2">
            <Avatar name={user ? displayName(user) : "You"} className="size-8" />
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg-subtle">
                Took {formatCourseCode(courseId)}? Share what it was like. Reviews are anonymous.
            </span>
            {isSignedIn ? (
                <Button size="sm" onClick={() => setOpen(true)}>
                    Write a review
                </Button>
            ) : (
                <Button size="sm" asChild>
                    <Link href={pagePath("/auth/login")}>Sign in to review</Link>
                </Button>
            )}
        </div>
    );
}

async function flagReview(review: Review) {
    if (!window.confirm("Flag this review for moderation?")) return;
    const response = await fetch("/api/flags/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_id: review.id }),
    });
    toast(response.ok ? "Thanks, a moderator will take a look" : "Couldn't flag this review. Try again later.");
}

function EditableReview({ review }: { review: Review }) {
    const { instructors, refresh } = useReviews();
    const user = useUser();
    const [editing, setEditing] = useState(false);
    const isOwn = review.user_id === user?.id;

    const save = async (draft: ReviewDraft) => {
        const { error } = await createClient()
            .from("reviews")
            .update(draft)
            .eq("id", review.id)
            .eq("user_id", user!.id);
        if (error) return error.message;
        setEditing(false);
        await refresh();
        return null;
    };

    if (editing) {
        return (
            <div className="border-b border-line py-5">
                <ReviewForm
                    instructors={instructors}
                    initial={review}
                    submitLabel="Save changes"
                    onSubmit={save}
                    onCancel={() => setEditing(false)}
                />
            </div>
        );
    }

    return (
        <ReviewItem
            review={review}
            context={isOwn ? "Your review" : undefined}
            actions={
                isOwn ? (
                    <SimpleTooltip label="Edit">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Edit review"
                            onClick={() => setEditing(true)}
                        >
                            <PencilSimpleIcon />
                        </Button>
                    </SimpleTooltip>
                ) : (
                    <SimpleTooltip label="Flag for moderation">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Flag review"
                            onClick={() => flagReview(review)}
                        >
                            <FlagIcon />
                        </Button>
                    </SimpleTooltip>
                )
            }
        />
    );
}

/** The Reviews tab: average scores, a filter by instructor, the composer and every review. */
export function CourseReviews() {
    const { reviews, status, rmpSummary } = useReviews();
    const [instructor, setInstructor] = useState(ALL);
    const shown = instructor === ALL ? reviews : reviews.filter((review) => review.instructor === instructor);
    const page = usePaged(shown, PAGE_SIZE);
    const reviewedInstructors = [...new Set(reviews.map((review) => review.instructor))];

    if (status === "unavailable") {
        return <EmptyState title="Reviews aren't available right now" description="Try again in a little while." />;
    }

    return (
        <section className="flex flex-col gap-6">
            {reviews.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <ReviewScoresSummary reviews={shown} />
                    {reviewedInstructors.length > 1 && (
                        <SegmentedControl
                            aria-label="Filter by instructor"
                            value={instructor}
                            onValueChange={(name) => {
                                setInstructor(name);
                                page.reset();
                            }}
                            options={[
                                { value: ALL, label: "All instructors" },
                                ...reviewedInstructors.map((name) => ({ value: name, label: name })),
                            ]}
                        />
                    )}
                </div>
            )}

            <Composer />

            {status === "ready" && reviews.length === 0 && rmpSummary.total === 0 && (
                <EmptyState title="No reviews yet" description="Be the first to say how this course went." />
            )}

            <div>
                {page.visible.map((review) => (
                    <EditableReview key={review.id} review={review} />
                ))}
            </div>
            <ShowMore className="mt-0 justify-start" count={page.nextPageSize} onClick={page.showMore} />
        </section>
    );
}
