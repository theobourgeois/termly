/**
 * University of Northern British Columbia: the timetable, final exams and descriptions from its
 * Banner 9 Self-Service class search (see ../lib/banner9.js).
 */
import { banner9 } from "../lib/banner9.js";

const seasons = {
    january: { season: "winter", end: "04-30" },
    may: { season: "summer", end: "08-31" },
    september: { season: "fall", end: "12-31" },
};

/** UNBC names terms by the month they start: "2026 September Semester", "2027 January Semester". */
function describeTerm({ description, starts_on }) {
    const match = description.match(/^(\d{4})\s+(January|May|September)/i);
    if (!match) return { name: description, season: "other", year: Number(starts_on.slice(0, 4)) };
    const { season } = seasons[match[2].toLowerCase()];
    return {
        name: `${season[0].toUpperCase()}${season.slice(1)} ${match[1]}`,
        season,
        year: Number(match[1]),
    };
}

function roughEnd({ description }) {
    const match = description.match(/^(\d{4})\s+(January|May|September)/i);
    return match ? `${match[1]}-${seasons[match[2].toLowerCase()].end}` : null;
}

export const { scrapeTimetable, scrapeCourseDetails } = banner9({
    baseUrl: "https://selfservice.unbc.ca/StudentRegistrationSsb/ssb",
    // Since October 2026 the search answers 500 for pages of about 500 sections.
    pageSize: 100,
    describeTerm,
    roughEnd,
    // Online classes meet in a building called ONLINE; theses have "No Scheduled Meeting Times".
    isOnline: (meeting, section) =>
        /^online$/i.test(meeting.building ?? "") ||
        (!meeting.building && /online|hyflex/i.test(section.instructionalMethodDescription ?? "")),
});
