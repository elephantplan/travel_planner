-- Accounts (Google login) and share links.
--
-- Every trip belongs to the account that made it. Other people see a trip
-- only if its owner gave them its share link (trip.html?trip=ID&s=TOKEN):
-- the page sends the token as the x-share-token request header, which the
-- policies below check. A logged-in person who opens a share link is also
-- remembered as a member, so the trip shows in their own list.
--
-- Trips from before accounts have no owner. Until someone claims one
-- (claim_trip, offered on the trip page when logged in), it stays open as
-- before, so nothing breaks on the day this is applied.

alter table public.trips add column if not exists owner_id uuid references auth.users(id) on delete set null default auth.uid();
alter table public.trips add column if not exists share_token uuid not null default gen_random_uuid();
alter table public.trips add column if not exists deleted_at timestamptz;
alter table public.trips add column if not exists cover_url text;

create table if not exists public.trip_members (
  trip_id bigint not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
alter table public.trip_members enable row level security;

create or replace function public.trip_share_header() returns text
language sql stable as $$
  select coalesce((nullif(current_setting('request.headers', true), '')::json ->> 'x-share-token'), '')
$$;

create or replace function public.can_access_trip(tid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.trips t
    where t.id = tid and (
      t.owner_id is null
      or t.owner_id = auth.uid()
      or t.share_token::text = public.trip_share_header()
      or exists (select 1 from public.trip_members m where m.trip_id = t.id and m.user_id = auth.uid())
    )
  )
$$;

-- an old trip with no owner becomes the caller's
create or replace function public.claim_trip(tid bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  update public.trips set owner_id = auth.uid() where id = tid and owner_id is null;
  return found;
end $$;

-- opening a share link while logged in: the trip joins the caller's list
create or replace function public.join_trip(tid bigint, tok uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if not exists (select 1 from public.trips where id = tid and share_token = tok) then return false; end if;
  insert into public.trip_members (trip_id, user_id) values (tid, auth.uid()) on conflict do nothing;
  return true;
end $$;

-- the owner can make the old link stop working (for people not logged in)
create or replace function public.reset_share_link(tid bigint) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid := gen_random_uuid();
begin
  update public.trips set share_token = t where id = tid and owner_id = auth.uid();
  if not found then return null; end if;
  -- people already on the trip stay; the owner removes them one by one
  return t;
end $$;

grant execute on function public.can_access_trip(bigint), public.trip_share_header() to anon, authenticated;
grant execute on function public.claim_trip(bigint), public.join_trip(bigint, uuid), public.reset_share_link(bigint) to authenticated;

-- trips
drop policy if exists "anyone can read trips" on public.trips;
drop policy if exists "anyone can insert a trip" on public.trips;
drop policy if exists "anyone can delete a trip" on public.trips;
drop policy if exists "anyone can mark deleted or set cover" on public.trips;
create policy "trips: read if allowed" on public.trips for select to anon, authenticated using (public.can_access_trip(id));
create policy "trips: logged-in people create their own" on public.trips for insert to authenticated with check (owner_id = auth.uid());
create policy "trips: owner deletes" on public.trips for delete to authenticated using (owner_id = auth.uid());
create policy "trips: mark deleted or set cover if allowed" on public.trips for update to anon, authenticated
  using (public.can_access_trip(id)) with check (public.can_access_trip(id));
revoke update on public.trips from anon, authenticated;
grant update (deleted_at, cover_url) on public.trips to anon, authenticated;

-- trip_members: each person sees their own memberships
create policy "members: own rows" on public.trip_members for select to authenticated using (user_id = auth.uid());
create policy "members: leave" on public.trip_members for delete to authenticated using (user_id = auth.uid());

-- versions
drop policy if exists "anyone can read versions" on public.itinerary_versions;
drop policy if exists "anyone can insert a new version" on public.itinerary_versions;
create policy "versions: read if allowed" on public.itinerary_versions for select to anon, authenticated using (public.can_access_trip(trip_id));
create policy "versions: add if allowed" on public.itinerary_versions for insert to anon, authenticated with check (public.can_access_trip(trip_id));
create policy "versions: prune if allowed" on public.itinerary_versions for delete to anon, authenticated using (public.can_access_trip(trip_id));

-- AI notes
drop policy if exists "anyone can read ai notes" on public.ai_notes;
drop policy if exists "anyone can add an ai note" on public.ai_notes;
drop policy if exists "anyone can delete an ai note" on public.ai_notes;
create policy "notes: read if allowed" on public.ai_notes for select to anon, authenticated using (public.can_access_trip(trip_id));
create policy "notes: add if allowed" on public.ai_notes for insert to anon, authenticated with check (public.can_access_trip(trip_id));
create policy "notes: delete if allowed" on public.ai_notes for delete to anon, authenticated using (public.can_access_trip(trip_id));
