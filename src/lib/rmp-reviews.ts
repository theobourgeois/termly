/** A RateMyProfessors review of a course, from the external_reviews table. */
export type RmpReview = {
    id: string;
    instructor: string;
    instructor_url: string | null;
    review_text: string | null;
    /** 1-5, and it rates the professor rather than the course. */
    quality: number | null;
    difficulty: number | null;
    would_take_again: boolean | null;
    grade: string | null;
    tags: string[];
    online: boolean | null;
    reviewed_at: string;
};

export const RMP_REVIEW_COLUMNS =
    "id, instructor, instructor_url, review_text, quality, difficulty, would_take_again, grade, tags, online, reviewed_at";

/**
 * How many reviews are sent with a course page: the first page of its Reviews tab. The browser loads
 * the rest when that tab opens, since popular courses have hundreds.
 */
export const RMP_PREVIEW_SIZE = 8;

/** Below this many answers, "would take again" isn't shown as a percentage. */
const MIN_TAKE_AGAIN_ANSWERS = 5;

export type RmpAverages = { quality: number | null; difficulty: number | null; takeAgain: number | null };

export function rmpAverages(reviews: RmpReview[]): RmpAverages {
    const average = (values: (number | null)[]) => {
        const scores = values.filter((value): value is number => value !== null);
        return scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10 : null;
    };
    const answers = reviews.filter((review) => review.would_take_again !== null);
    return {
        quality: average(reviews.map((review) => review.quality)),
        difficulty: average(reviews.map((review) => review.difficulty)),
        takeAgain:
            answers.length >= MIN_TAKE_AGAIN_ANSWERS
                ? Math.round((answers.filter((review) => review.would_take_again).length / answers.length) * 100)
                : null,
    };
}

/** What a course page says about all of its reviews, so it can say it without having all of them. */
export type RmpSummary = {
    total: number;
    averages: RmpAverages;
    /** Everyone reviewed, most reviews first. */
    instructors: { name: string; count: number; averages: RmpAverages }[];
    /** Years of the oldest and newest review; null when there are no reviews. */
    years: { oldest: number; newest: number } | null;
};

export function summarizeRmp(reviews: RmpReview[]): RmpSummary {
    const byInstructor = new Map<string, RmpReview[]>();
    for (const review of reviews) {
        byInstructor.set(review.instructor, [...(byInstructor.get(review.instructor) ?? []), review]);
    }
    const years = reviews.map((review) => new Date(review.reviewed_at).getFullYear());
    return {
        total: reviews.length,
        averages: rmpAverages(reviews),
        instructors: [...byInstructor]
            .map(([name, theirs]) => ({ name, count: theirs.length, averages: rmpAverages(theirs) }))
            .sort((a, b) => b.count - a.count),
        years: years.length > 0 ? { oldest: Math.min(...years), newest: Math.max(...years) } : null,
    };
}
