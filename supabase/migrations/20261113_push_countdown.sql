-- Daily 9am countdown to the next trip: which phones want it, and the day
-- each one last got it (so a repeated run never sends twice). Applied 2026-11-13.
alter table public.push_subs add column if not exists countdown boolean not null default false;
alter table public.push_subs add column if not exists last_countdown date;
