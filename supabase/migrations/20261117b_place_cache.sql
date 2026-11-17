-- Google Places answers kept by the edge functions (service role only), so a
-- place's hours, rating, reviews or nearest station are asked of Google once
-- and then read from here by every trip and every family.
create table if not exists public.place_cache (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.place_cache enable row level security;
