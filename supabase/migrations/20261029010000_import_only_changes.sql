-- The imports rewrote every row they were given, changed or not: each daily refresh updated every
-- course and section of 25 universities, deleted and re-added every meeting, room link and
-- instructor link, and replaced every exam. Postgres writes a new copy of a row on each update (and
-- dirties its page even to lock it), so this used most of the database's disk IO budget on rows
-- that were the same as yesterday. The imports now compare first and only write rows that are new,
-- changed or gone.
--
-- last_seen_at on courses, sections and rooms was bumped on every import just to say the row was
-- still there, and nothing reads it, so it goes.

alter table public.courses drop column last_seen_at;
alter table public.sections drop column last_seen_at;
alter table public.rooms drop column last_seen_at;

create or replace function public.import_terms(p_university text, p_terms jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
    imported integer;
begin
    insert into public.terms (university_id, code, name, season, year, starts_on, ends_on)
    select p_university, x.code, x.name, x.season, x.year, x.starts_on, x.ends_on
    from jsonb_to_recordset(p_terms) as x(
        code text, name text, season public.term_season, year smallint, starts_on date, ends_on date
    )
    where not exists (
        select 1 from public.terms t
        where t.university_id = p_university and t.code = x.code
            and (t.name, t.season, t.year, t.starts_on, t.ends_on)
                is not distinct from (x.name, x.season, x.year, x.starts_on, x.ends_on)
    )
    on conflict (university_id, code) do update set
        name = excluded.name,
        season = excluded.season,
        year = excluded.year,
        starts_on = excluded.starts_on,
        ends_on = excluded.ends_on;
    get diagnostics imported = row_count;
    return imported;
end;
$$;

-- Same payload and checks as before. Returns {sections, changed, deleted}: sections in the payload,
-- how many of them were new or changed, and how many stored sections were removed.
create or replace function public.import_timetable(p_university text, p_payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
    problem text;
    section_count integer;
    changed_count integer;
    deleted_count integer;
begin
    -- Unchanged rows are filtered out before each insert, not by a WHERE on the update: a
    -- conflicting row is locked (written to) before that WHERE is checked.
    insert into public.subjects (university_id, code, name)
    select p_university, x.code, x.name
    from jsonb_to_recordset(coalesce(p_payload -> 'subjects', '[]')) as x(code text, name text)
    where not exists (
        select 1 from public.subjects s
        where s.university_id = p_university and s.code = x.code and s.name is not distinct from x.name
    )
    on conflict (university_id, code) do update set name = excluded.name;

    insert into public.courses (university_id, code, subject_code, number, title, credits)
    select p_university, x.code, x.subject_code, x.number, x.title, x.credits
    from jsonb_to_recordset(coalesce(p_payload -> 'courses', '[]')) as x(
        code text, subject_code text, number text, title text, credits numeric
    )
    where not exists (
        select 1 from public.courses stored
        where stored.university_id = p_university and stored.code = x.code
            and (stored.subject_code, stored.number, stored.title, stored.credits)
                is not distinct from (x.subject_code, x.number, x.title, x.credits::numeric(6, 2))
    )
    on conflict (university_id, code) do update set
        subject_code = excluded.subject_code,
        number = excluded.number,
        title = excluded.title,
        credits = excluded.credits;

    create temporary table import_scope on commit drop as
    select t.id as term_id, s.term, s.subject
    from jsonb_to_recordset(coalesce(p_payload -> 'scope', '[]')) as s(term text, subject text)
    left join public.terms t on t.university_id = p_university and t.code = s.term;

    select string_agg(distinct term, ', ') into problem from pg_temp.import_scope where term_id is null;
    if problem is not null then
        raise exception 'Unknown terms in scope: %', problem;
    end if;

    create temporary table import_sections on commit drop as
    select t.id as term_id, c.id as course_id, c.subject_code, x.*
    from jsonb_to_recordset(coalesce(p_payload -> 'sections', '[]')) as x(
        term text, crn text, course text, section text, type text, kind public.section_kind,
        credits numeric, capacity integer, enrolled integer, waitlist integer, starts_on date,
        ends_on date, link_code text, cross_listed_codes text[], notes text, meetings jsonb,
        instructors jsonb
    )
    left join public.terms t on t.university_id = p_university and t.code = x.term
    left join public.courses c on c.university_id = p_university and c.code = x.course;

    select string_agg(distinct term || ' ' || coalesce(crn, '?') || ' ' || coalesce(course, '?'), ', ') into problem
    from pg_temp.import_sections where term_id is null or course_id is null;
    if problem is not null then
        raise exception 'Sections with an unknown term or course: %', problem;
    end if;

    select string_agg(term || ' ' || crn, ', ') into problem
    from (select term, crn from pg_temp.import_sections group by term, crn having count(*) > 1) duplicates;
    if problem is not null then
        raise exception 'Duplicate sections: %', problem;
    end if;

    select string_agg(distinct x.term || ' ' || x.subject_code, ', ') into problem
    from pg_temp.import_sections x
    where not exists (
        select 1 from pg_temp.import_scope s where s.term_id = x.term_id and s.subject = x.subject_code
    );
    if problem is not null then
        raise exception 'Sections outside the scope: %', problem;
    end if;

    select count(*) into section_count from pg_temp.import_sections;

    insert into public.sections (
        university_id, term_id, course_id, crn, section, type, kind, credits, capacity, enrolled,
        waitlist, starts_on, ends_on, link_code, cross_listed_codes, notes
    )
    select
        p_university, x.term_id, x.course_id, x.crn, x.section, x.type, x.kind, x.credits, x.capacity,
        x.enrolled, x.waitlist, x.starts_on, x.ends_on, x.link_code, coalesce(x.cross_listed_codes, '{}'),
        x.notes
    from pg_temp.import_sections x
    where not exists (
        select 1 from public.sections s
        where s.term_id = x.term_id and s.crn = x.crn
            and (s.course_id, s.section, s.type, s.kind, s.credits, s.capacity, s.enrolled, s.waitlist,
                 s.starts_on, s.ends_on, s.link_code, s.cross_listed_codes, s.notes)
            is not distinct from
                (x.course_id, x.section, x.type, x.kind, x.credits::numeric(6, 2), x.capacity, x.enrolled, x.waitlist,
                 x.starts_on, x.ends_on, x.link_code, coalesce(x.cross_listed_codes, '{}'), x.notes)
    )
    on conflict (term_id, crn) do update set
        course_id = excluded.course_id,
        section = excluded.section,
        type = excluded.type,
        kind = excluded.kind,
        credits = excluded.credits,
        capacity = excluded.capacity,
        enrolled = excluded.enrolled,
        waitlist = excluded.waitlist,
        starts_on = excluded.starts_on,
        ends_on = excluded.ends_on,
        link_code = excluded.link_code,
        cross_listed_codes = excluded.cross_listed_codes,
        notes = excluded.notes;
    get diagnostics changed_count = row_count;

    create temporary table import_section_ids on commit drop as
    select s.id, x.meetings, x.instructors
    from pg_temp.import_sections x
    join public.sections s on s.term_id = x.term_id and s.crn = x.crn;

    -- Meetings: the ones a section no longer has are deleted (their room links go with them), and
    -- only new or changed ones are written.
    create temporary table import_meetings on commit drop as
    select
        x.id as section_id,
        (m.position - 1)::smallint as position,
        array(select jsonb_array_elements_text(coalesce(m.meeting -> 'days', '[]'))) as days,
        (m.meeting ->> 'start_time')::time as start_time,
        (m.meeting ->> 'end_time')::time as end_time,
        m.meeting ->> 'location' as location,
        (m.meeting ->> 'starts_on')::date as starts_on,
        (m.meeting ->> 'ends_on')::date as ends_on
    from pg_temp.import_section_ids x
    cross join lateral jsonb_array_elements(coalesce(x.meetings, '[]')) with ordinality as m(meeting, position);

    delete from public.section_meetings m
    using pg_temp.import_section_ids x
    where m.section_id = x.id
        and not exists (
            select 1 from pg_temp.import_meetings n where n.section_id = m.section_id and n.position = m.position
        );

    insert into public.section_meetings (section_id, position, days, start_time, end_time, location, starts_on, ends_on)
    select n.section_id, n.position, n.days, n.start_time, n.end_time, n.location, n.starts_on, n.ends_on
    from pg_temp.import_meetings n
    where not exists (
        select 1 from public.section_meetings m
        where m.section_id = n.section_id and m.position = n.position
            and (m.days, m.start_time, m.end_time, m.location, m.starts_on, m.ends_on)
                is not distinct from (n.days, n.start_time, n.end_time, n.location, n.starts_on, n.ends_on)
    )
    on conflict (section_id, position) do update set
        days = excluded.days,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        location = excluded.location,
        starts_on = excluded.starts_on,
        ends_on = excluded.ends_on;

    -- The rooms each meeting is in. Rooms are kept once seen, like courses.
    create temporary table import_meeting_rooms on commit drop as
    select distinct
        x.id as section_id,
        (m.position - 1)::smallint as position,
        nullif(trim(r.room ->> 'campus'), '') as campus,
        trim(r.room ->> 'building') as building,
        nullif(trim(r.room ->> 'room'), '') as room
    from pg_temp.import_section_ids x
    cross join lateral jsonb_array_elements(coalesce(x.meetings, '[]')) with ordinality as m(meeting, position)
    cross join lateral jsonb_array_elements(coalesce(m.meeting -> 'rooms', '[]')) as r(room);

    insert into public.rooms (university_id, campus, building, room)
    select distinct p_university, campus, building, room from pg_temp.import_meeting_rooms
    on conflict (university_id, campus, building, room) do nothing;

    create temporary table import_room_links on commit drop as
    select distinct x.section_id, x.position, r.id as room_id
    from pg_temp.import_meeting_rooms x
    join public.rooms r
        on r.university_id = p_university
        and r.campus is not distinct from x.campus
        and r.building = x.building
        and r.room is not distinct from x.room;

    delete from public.meeting_rooms l
    using pg_temp.import_section_ids x
    where l.section_id = x.id
        and not exists (
            select 1 from pg_temp.import_room_links n
            where n.section_id = l.section_id and n.position = l.position and n.room_id = l.room_id
        );

    insert into public.meeting_rooms (section_id, position, room_id)
    select section_id, position, room_id from pg_temp.import_room_links
    on conflict do nothing;

    insert into public.instructors (university_id, name)
    select distinct p_university, i.person ->> 'name'
    from pg_temp.import_section_ids x
    cross join lateral jsonb_array_elements(coalesce(x.instructors, '[]')) as i(person)
    on conflict (university_id, name) do nothing;

    create temporary table import_section_people on commit drop as
    select distinct on (x.id, people.id)
        x.id as section_id,
        people.id as instructor_id,
        coalesce((i.person ->> 'is_primary')::boolean, false) as is_primary,
        (i.position - 1)::smallint as position
    from pg_temp.import_section_ids x
    cross join lateral jsonb_array_elements(coalesce(x.instructors, '[]')) with ordinality as i(person, position)
    join public.instructors people on people.university_id = p_university and people.name = i.person ->> 'name'
    order by x.id, people.id, i.position;

    delete from public.section_instructors l
    using pg_temp.import_section_ids x
    where l.section_id = x.id
        and not exists (
            select 1 from pg_temp.import_section_people n
            where n.section_id = l.section_id and n.instructor_id = l.instructor_id
        );

    insert into public.section_instructors (section_id, instructor_id, is_primary, position)
    select n.section_id, n.instructor_id, n.is_primary, n.position
    from pg_temp.import_section_people n
    where not exists (
        select 1 from public.section_instructors l
        where l.section_id = n.section_id and l.instructor_id = n.instructor_id
            and l.is_primary = n.is_primary and l.position = n.position
    )
    on conflict (section_id, instructor_id) do update set
        is_primary = excluded.is_primary,
        position = excluded.position;

    delete from public.sections s
    using pg_temp.import_scope scope, public.courses c
    where s.term_id = scope.term_id
        and c.id = s.course_id
        and c.subject_code = scope.subject
        and not exists (select 1 from pg_temp.import_sections x where x.term_id = s.term_id and x.crn = s.crn);
    get diagnostics deleted_count = row_count;

    return jsonb_build_object('sections', section_count, 'changed', changed_count, 'deleted', deleted_count);
end;
$$;

-- Same as before: returns how many of the given courses are stored, changed or not, so refresh.js
-- can still tell a calendar that returned nothing from one that returned the same as last week.
create or replace function public.import_course_details(p_university text, p_courses jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
    found integer;
begin
    create temporary table import_details on commit drop as
    select c.id, x.description, x.requisites_text, x.requisites
    from jsonb_to_recordset(p_courses) as x(code text, description text, requisites_text text, requisites jsonb)
    join public.courses c on c.university_id = p_university and c.code = x.code;
    select count(*) into found from pg_temp.import_details;

    update public.courses c
    set description = d.description, requisites_text = d.requisites_text, details_updated_at = now()
    from pg_temp.import_details d
    where c.id = d.id
        and (c.description, c.requisites_text) is distinct from (d.description, d.requisites_text);

    create temporary table import_requisites on commit drop as
    select distinct d.id as course_id, required.id as required_course_id, r.kind
    from pg_temp.import_details d
    cross join lateral jsonb_to_recordset(coalesce(d.requisites, '[]')) as r(code text, kind public.requisite_kind)
    join public.courses required on required.university_id = p_university and required.code = r.code
    where required.id <> d.id;

    delete from public.course_requisites cr
    using pg_temp.import_details d
    where cr.course_id = d.id
        and not exists (
            select 1 from pg_temp.import_requisites n
            where n.course_id = cr.course_id and n.kind = cr.kind and n.required_course_id = cr.required_course_id
        );

    insert into public.course_requisites (course_id, required_course_id, kind)
    select course_id, required_course_id, kind from pg_temp.import_requisites
    on conflict do nothing;

    return found;
end;
$$;

-- Same as before: makes the term's exams exactly these, and returns how many there are.
create or replace function public.import_exams(p_university text, p_term text, p_exams jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
    exam_term uuid;
    saved integer;
begin
    select id into exam_term from public.terms where university_id = p_university and code = p_term;
    if exam_term is null then
        raise exception 'Unknown term: %', p_term;
    end if;

    create temporary table import_exam_rows on commit drop as
    select distinct on (c.id, x.section) c.id as course_id, x.section, x.starts_at, x.ends_at, x.location
    from jsonb_to_recordset(p_exams) as x(course text, section text, starts_at timestamptz, ends_at timestamptz, location text)
    join public.courses c on c.university_id = p_university and c.code = x.course
    order by c.id, x.section, x.starts_at;
    select count(*) into saved from pg_temp.import_exam_rows;

    delete from public.exams e
    where e.term_id = exam_term
        and not exists (
            select 1 from pg_temp.import_exam_rows n where n.course_id = e.course_id and n.section = e.section
        );

    insert into public.exams (university_id, term_id, course_id, section, starts_at, ends_at, location)
    select p_university, exam_term, n.course_id, n.section, n.starts_at, n.ends_at, n.location
    from pg_temp.import_exam_rows n
    where not exists (
        select 1 from public.exams stored
        where stored.term_id = exam_term and stored.course_id = n.course_id and stored.section = n.section
            and (stored.starts_at, stored.ends_at, stored.location)
                is not distinct from (n.starts_at, n.ends_at, n.location)
    )
    on conflict (term_id, course_id, section) do update set
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        location = excluded.location;

    return saved;
end;
$$;
