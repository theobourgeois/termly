import type { Metadata } from "next";
import { Page, PageActions, PageHeader, SectionHeader } from "@/components/layout/page";
import { FreeRoomList } from "@/components/rooms/room-links";
import { RoomSchedule } from "@/components/rooms/room-schedule";
import { RoomSearch } from "@/components/rooms/room-search";
import { getCurrentTerm, getListedTerms, getRooms, getRoomSessions } from "@/lib/data";
import { findFreeRooms, freeWindows, isCampusHours, roomStatus } from "@/lib/rooms";
import { campusNow } from "@/lib/time";
import { getUniversity, universityPath } from "@/lib/university";
import { universityPageMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ university: string }> }): Promise<Metadata> {
    const { university } = await params;
    const { name } = getUniversity(university)!;
    return universityPageMetadata(university, "/rooms", {
        title: `Empty classrooms at ${name}`,
        description: `Find a ${name} classroom that's free right now, or see when any room is booked this term, from the class timetable.`,
    });
}

/**
 * Rendered on every request: what's free depends on the time, and the room and term are in the query.
 * Without this the page counts as static (its layout's generateStaticParams), and reading the query at
 * request time fails the render.
 */
export const dynamic = "force-dynamic";

type Props = {
    params: Promise<{ university: string }>;
    searchParams: Promise<{ room?: string; term?: string }>;
};

export default async function RoomsPage({ params, searchParams }: Props) {
    const { university } = await params;
    const query = await searchParams;
    const [currentTerm, listed] = await Promise.all([getCurrentTerm(university), getListedTerms(university)]);
    const term = query.term && listed.includes(query.term) ? query.term : currentTerm;
    const [sessionsByRoom, allRooms] = await Promise.all([getRoomSessions(university, term), getRooms(university)]);
    // Searchable: the rooms with classes this term.
    const rooms = [...sessionsByRoom.keys()]
        .map((id) => allRooms.get(id)!)
        .sort((a, b) => a.name.localeCompare(b.name));
    // A room opens even in a term it has no classes in, so switching terms doesn't lose it.
    const room = query.room ? allRooms.get(query.room) : undefined;
    const now = campusNow(getUniversity(university)?.timezone ?? "UTC");
    const live = term === currentTerm && isCampusHours(now);

    if (!room) {
        return (
            <Page breadcrumbs={[{ label: "Rooms" }]}>
                <PageHeader
                    title="Rooms"
                    description="See when any room on campus is booked, or find one that's free right now."
                />
                <PageActions>
                    <RoomSearch rooms={rooms} term={term} size="lg" />
                </PageActions>
                {live && (
                    <section className="mt-11">
                        <SectionHeader title="Free right now" className="mb-4" />
                        <FreeRoomList rooms={findFreeRooms(sessionsByRoom, allRooms, now, undefined, 10)} term={term} />
                    </section>
                )}
            </Page>
        );
    }

    const sessions = sessionsByRoom.get(room.id) ?? [];

    return (
        <Page breadcrumbs={[{ label: "Rooms", href: universityPath(university, "/rooms") }, { label: room.name }]}>
            <PageHeader title={room.name} subtitle={room.campus ? `${room.campus} campus` : undefined} />
            <PageActions>
                <RoomSearch rooms={rooms} term={term} />
            </PageActions>
            <RoomSchedule
                room={room}
                sessions={sessions}
                term={term}
                status={live ? roomStatus(sessions, now) : null}
                freeWindows={live && now.day ? freeWindows(sessions, now.day, now.minutes) : []}
                freeRooms={live ? findFreeRooms(sessionsByRoom, allRooms, now, room, 4) : []}
            />
        </Page>
    );
}
