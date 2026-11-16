-- 刪除 marks a trip instead of wiping it (最近刪除, restorable for 30 days),
-- and each trip keeps a cover picture for the trip list. The app may only
-- change these two columns of a trip.
alter table public.trips add column if not exists deleted_at timestamptz;
alter table public.trips add column if not exists cover_url text;
revoke update on public.trips from anon, authenticated;
grant update (deleted_at, cover_url) on public.trips to anon, authenticated;
drop policy if exists "anyone can mark deleted or set cover" on public.trips;
create policy "anyone can mark deleted or set cover" on public.trips for update to anon, authenticated using (true) with check (true);
