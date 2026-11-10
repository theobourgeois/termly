"use client";

import { SectionHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { formatReviewDate } from "@/lib/reviews";
import { useCourse } from "./course-context";
import { ReviewScoresSummary } from "@/components/reviews/review-summary";
import { RmpScoresSummary } from "@/components/reviews/rmp-reviews";
import { useReviews } from "@/components/reviews/reviews-context";

function LatestReview({ text, caption }: { text: string; caption: string }) {
    return (
        <figure className="mt-5 max-w-[42rem] rounded-card bg-raised px-6 py-5">
            <blockquote className="line-clamp-4 text-[15px] font-medium leading-relaxed text-fg-body">{text}</blockquote>
            <figcaption className="mt-2 text-[13px] text-fg-subtle">{caption}</figcaption>
        </figure>
    );
}

/**
 * "What students say" on the Overview tab: the site's own reviews when there are some, otherwise what
 * students said on RateMyProfessors.
 */
export function ReviewsSummary() {
    const { reviews, status, rmpReviews, rmpSummary } = useReviews();
    const { setTab } = useCourse();
    if (status === "loading" || (status === "unavailable" && rmpSummary.total === 0)) return null;

    const total = reviews.length + rmpSummary.total;
    const [latest] = reviews;
    const latestRmp = rmpReviews.find((review) => review.review_text);

    return (
        <section className="mt-11">
            <SectionHeader title="What students say">
                <Button variant="link" className="font-bold" onClick={() => setTab("reviews")}>
                    {total > 0 ? `All ${total} reviews` : "Write the first review"}
                </Button>
            </SectionHeader>
            {latest ? (
                <>
                    <div className="mt-4">
                        <ReviewScoresSummary reviews={reviews} />
                    </div>
                    <LatestReview
                        text={latest.review_text}
                        caption={`Latest review, ${formatReviewDate(latest.created_at)} with ${latest.instructor}`}
                    />
                    {rmpSummary.total > 0 && (
                        <p className="mt-3 text-[13px] text-fg-subtle">
                            Plus {rmpSummary.total} from RateMyProfessors on the Reviews tab.
                        </p>
                    )}
                </>
            ) : rmpSummary.total > 0 ? (
                <>
                    <div className="mt-4">
                        <RmpScoresSummary averages={rmpSummary.averages} />
                    </div>
                    {latestRmp?.review_text && (
                        <LatestReview
                            text={latestRmp.review_text}
                            caption={`Latest on RateMyProfessors, ${formatReviewDate(latestRmp.reviewed_at)} with ${latestRmp.instructor}`}
                        />
                    )}
                </>
            ) : (
                <p className="mt-3 text-sm font-medium text-fg-muted">Nobody has reviewed this course yet.</p>
            )}
        </section>
    );
}
