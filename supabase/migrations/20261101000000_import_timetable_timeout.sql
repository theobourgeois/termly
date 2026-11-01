-- Importing one subject is one call, and a subject can't be split across calls: the import deletes
-- whatever in its term and subject isn't in the payload. Guelph's ENGG has over 1,100 sections and
-- 3,200 meetings in a term, which takes longer than the API's statement timeout (about 8s), so its
-- refresh failed on 2026-10-26 and 2026-11-01 even after retrying, leaving the subjects after ENGG
-- out of date. This one function now gets longer. PostgREST reads the setting from its schema cache
-- and applies it before calling the function; setting it inside the function would be too late.

alter function public.import_timetable(text, jsonb) set statement_timeout = '60s';

notify pgrst, 'reload schema';
