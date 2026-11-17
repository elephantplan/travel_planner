-- 改動紀錄: each trip keeps its newest 100 saved versions; older ones are
-- removed automatically after every save. The newest is always among them.
create or replace function public.itinerary_versions_keep_recent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.itinerary_versions v
  where v.trip_id = new.trip_id
    and v.id not in (
      select k.id from public.itinerary_versions k
      where k.trip_id = new.trip_id
      order by k.created_at desc, k.id desc
      limit 100);
  return null;
end $$;
drop trigger if exists itinerary_versions_keep_recent on public.itinerary_versions;
create trigger itinerary_versions_keep_recent after insert on public.itinerary_versions
  for each row execute function public.itinerary_versions_keep_recent();
