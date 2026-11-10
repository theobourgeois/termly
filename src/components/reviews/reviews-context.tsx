"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Review } from "@/lib/reviews";
import { RMP_REVIEW_COLUMNS, summarizeRmp, type RmpReview, type RmpSummary } from "@/lib/rmp-reviews";
import { createClient, hasSupabase } from "@/lib/supabase/client";
import { useUniversity } from "@/components/university";

type ReviewsState = {
    courseId: string;
    instructors: string[];
    reviews: Review[];
    status: "loading" | "ready" | "unavailable";
    /** RateMyProfessors reviews of this course, newest first: the few sent with the page until the rest load. */
    rmpReviews: RmpReview[];
    /** Counts and averages over every RateMyProfessors review, loaded or not. */
    rmpSummary: RmpSummary;
    /** Whether `rmpReviews` is all of them. */
    rmpComplete: boolean;
    /** Loads the RateMyProfessors reviews that didn't come with the page. */
    loadRmpReviews: () => Promise<void>;
    /** Drops a RateMyProfessors review a moderator just hid. */
    removeRmpReview: (id: string) => void;
    refresh: () => Promise<void>;
};

const ReviewsContext = createContext<ReviewsState | null>(null);

/** Loads a course's reviews once and shares them between the overview summary and the Reviews tab. */
export function ReviewsProvider({
    courseId,
    instructors,
    rmpReviews: rmpPreview,
    rmpSummary: rmpPreviewSummary,
    children,
}: {
    courseId: string;
    instructors: string[];
    /** The newest RateMyProfessors reviews, and the summary of all of them. */
    rmpReviews: RmpReview[];
    rmpSummary: RmpSummary;
    children: React.ReactNode;
}) {
    const { id: university } = useUniversity();
    const [reviews, setReviews] = useState<Review[]>([]);
    const [status, setStatus] = useState<ReviewsState["status"]>(hasSupabase ? "loading" : "unavailable");
    // Kept with the course they belong to: this provider stays mounted from one course page to the next.
    const course = `${university}/${courseId}`;
    const [allRmp, setAllRmp] = useState<{ course: string; reviews: RmpReview[] } | null>(null);
    const [removedRmp, setRemovedRmp] = useState<string[]>([]);
    const loadingRmp = useRef<string | null>(null);

    const refresh = useCallback(async () => {
        if (!hasSupabase) return;
        const { data, error } = await createClient()
            .from("reviews")
            .select("*")
            .eq("university_id", university)
            .eq("course_code", courseId)
            .order("created_at", { ascending: false });
        setReviews(error ? [] : (data as Review[]));
        setStatus(error ? "unavailable" : "ready");
    }, [courseId, university]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const loadRmpReviews = useCallback(async () => {
        if (!hasSupabase || loadingRmp.current === course) return;
        loadingRmp.current = course;
        const { data, error } = await createClient()
            .from("external_reviews")
            .select(RMP_REVIEW_COLUMNS)
            .eq("university_id", university)
            .eq("source", "rmp")
            .eq("course_code", courseId)
            // Moderators are allowed to read hidden reviews, but course pages don't show them to anyone.
            .is("hidden_at", null)
            .order("reviewed_at", { ascending: false });
        if (loadingRmp.current === course) loadingRmp.current = null;
        if (!error) setAllRmp({ course, reviews: data as RmpReview[] });
    }, [course, courseId, university]);

    const removeRmpReview = useCallback((id: string) => setRemovedRmp((current) => [...current, id]), []);

    const value = useMemo(() => {
        const loaded = allRmp?.course === course ? allRmp.reviews : null;
        const rmpReviews = (loaded ?? rmpPreview).filter((review) => !removedRmp.includes(review.id));
        const rmpComplete = loaded !== null || rmpPreviewSummary.total <= rmpPreview.length;
        return {
            courseId,
            instructors,
            reviews,
            status,
            rmpReviews,
            rmpSummary: rmpComplete ? summarizeRmp(rmpReviews) : rmpPreviewSummary,
            rmpComplete,
            loadRmpReviews,
            removeRmpReview,
            refresh,
        };
    }, [
        allRmp,
        course,
        courseId,
        instructors,
        reviews,
        status,
        rmpPreview,
        rmpPreviewSummary,
        removedRmp,
        loadRmpReviews,
        removeRmpReview,
        refresh,
    ]);
    return <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>;
}

export function useReviews(): ReviewsState {
    const context = useContext(ReviewsContext);
    if (!context) throw new Error("useReviews must be used inside ReviewsProvider");
    return context;
}
