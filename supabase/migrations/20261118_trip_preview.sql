-- A shared trip link pasted into WhatsApp (or iMessage, Telegram…) shows a
-- card: the trip's name, its dates and its cover picture. The chat app's
-- preview robot has no login, so the Netlify edge function asks this with
-- the link's own share token. Only those four things come back, and only
-- for the right token — nothing of the itinerary itself.
create or replace function public.trip_preview(tid bigint, tok text)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'name', t.name,
    'destination', t.destination_local,
    'date_start', t.date_start,
    'date_end', t.date_end,
    'cover_url', t.cover_url)
  from public.trips t
  where t.id = tid
    and t.deleted_at is null
    and t.share_token::text = tok
$$;

revoke all on function public.trip_preview(bigint, text) from public;
grant execute on function public.trip_preview(bigint, text) to anon, authenticated;
