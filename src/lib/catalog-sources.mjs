/**
 * What makes up a university's catalog, read by the site (src/lib/data.ts) when a deployment has no
 * catalog file for that university, and by src/scripts/node/publish-catalogs.js to write those files.
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

/** The bucket the files are published to, and the folder a build downloads them into. */
export const CATALOG_BUCKET = "catalogs";
export const CATALOG_DIRECTORY = "catalogs";

/** @param {string} university */
export const catalogFileName = (university) => `${university}.json.gz`;
