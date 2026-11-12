-- 改動紀錄: let the family clear out old history from the app, the same way
-- trips and AI notes can be deleted (anyone with the app's anon key). The
-- latest saved version of each trip can never be deleted, so the trip itself
-- is always safe.
create policy "anyone can delete an old version" on public.itinerary_versions
  for delete to anon, authenticated
  using (
    id <> (
      select v.id from public.itinerary_versions v
      where v.trip_id = itinerary_versions.trip_id and v.snapshot is not null
      order by v.created_at desc, v.id desc limit 1
    )
  );
