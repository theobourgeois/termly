-- Sections and exams are read per university (the site's catalog load, refresh.js's stored-section
-- count), but neither table had an index starting with university_id, so every one of those reads
-- scanned all universities' rows. With 25 universities that got slow enough to time out under load.
-- (university_id, id) also serves readAllById in src/lib/data.ts, which pages catalog_sections by id.
create index sections_university_idx on public.sections (university_id, id);
create index exams_university_idx on public.exams (university_id);
