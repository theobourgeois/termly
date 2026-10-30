-- Each university's catalog as one file, written after the daily refresh and copied into each
-- deployment at build time, so serving the site doesn't read catalogs from the database.
-- Public like the data in it. Only the secret key can write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogs', 'catalogs', true, 20971520, array['application/gzip']);
