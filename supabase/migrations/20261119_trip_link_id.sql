-- Random URL identifiers, with the existing primary key and RLS policies intact.
alter table public.trips
  add column link_id uuid not null default gen_random_uuid(),
  add constraint trips_link_id_key unique (link_id);
