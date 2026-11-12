/**
 * What makes up a university's catalog, read by src/scripts/node/publish-catalogs.js to write the
 * catalog files, and by the site (src/lib/data.ts) in development, where there are no files.
 * Plain JavaScript because both import it.
 */
export const CATALOG_SOURCES = {
    terms: { source: "terms", columns: "code,name,starts_on,ends_on,is_listed", order: ["starts_on", "code"] },
    subjects: { source: "subjects", columns: "code,name", order: ["code"] },
    courses: {
        source: "catalog_courses",
        columns: "code,subject_code,number,title,credits,description",
        order: ["code"],
    },
    // Read by id rather than by offset: this view builds JSON per row. See readAllById in data.ts.
    sections: {
        source: "catalog_sections",
        columns: "term,course,crn,section,type,kind,capacity,enrolled,meetings,instructors",
    },
    prerequisites: {
        source: "course_requisite_codes",
        columns: "course,required",
        order: ["course", "required"],
        filters: { kind: "prerequisite" },
    },
    ratings: {
        source: "instructor_rating_by_name",
        columns: "match_name,first_name,last_name,profile_url,rating,difficulty,would_take_again,rating_count",
        order: ["match_name"],
    },
    exams: {
        source: "exam_schedule",
        columns: "term,course,section,starts_at,ends_at,location",
        order: ["term", "course", "section"],
    },
    rooms: { source: "rooms", columns: "id,campus,building,name", order: ["id"] },
};

/**
 * What course pages show besides the catalog: RateMyProfessors reviews and syllabi. In a file of their
 * own because they change weekly while the catalog changes daily, so the daily publish needn't read
 * them again. `filters` are PostgREST conditions, as written in a query string.
 */
export const CONTENT_SOURCES = {
    rmpReviews: {
        source: "external_reviews",
        columns:
            "course_code,id,instructor,instructor_url,review_text,quality,difficulty,would_take_again,grade,tags,online,reviewed_at",
        order: ["id"],
        filters: { source: "eq.rmp", course_code: "not.is.null", hidden_at: "is.null" },
    },
    syllabi: {
        source: "syllabi",
        columns:
            "id,source_url,upload_id,archived,course_codes,term_season,term_year,instructors,grading_schemes,weights_add_up,textbooks,policies,weekly_topics",
        order: ["id"],
    },
};

/** The bucket the files are published to, and the folder a build downloads them into. */
export const CATALOG_BUCKET = "catalogs";
export const CATALOG_DIRECTORY = "catalogs";

/** @param {string} university */
export const catalogFileName = (university) => `${university}.json.gz`;

/** @param {string} university */
export const contentFileName = (university) => `${university}.content.json.gz`;

/** Written by the build next to the files: each university's course codes, for the sitemap and counts. */
export const CATALOG_SUMMARY = "summary.json";
