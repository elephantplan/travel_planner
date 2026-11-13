-- Web push for the trip app. Phones that switched notifications on, per trip,
-- and the server's own signing key (made by the trip-push function on first
-- use). RLS is on with no policies: only the function (service role) can
-- read or write either table. Applied 2026-11-13.
create table if not exists public.push_subs (
  id bigint generated always as identity primary key,
  trip_id bigint not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text default '',
  editor text default '',
  created_at timestamptz not null default now()
);
create index if not exists push_subs_trip on public.push_subs (trip_id);
alter table public.push_subs enable row level security;

create table if not exists public.push_keys (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_jwk jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_keys enable row level security;
