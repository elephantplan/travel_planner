-- DumboFly: accounts, share links, names and pictures, 最近刪除, trip covers.
-- Paste the whole file into Supabase → SQL Editor → Run. Safe to run twice.
-- After it runs: open each of your old trips while logged in and tap
-- 「撥入我個 account」; until then an old trip stays open to anyone with its address.

begin;
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
drop policy if exists "trips: read if allowed" on public.trips;
create policy "trips: read if allowed" on public.trips for select to anon, authenticated using (public.can_access_trip(id));
drop policy if exists "trips: logged-in people create their own" on public.trips;
create policy "trips: logged-in people create their own" on public.trips for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists "trips: owner deletes" on public.trips;
create policy "trips: owner deletes" on public.trips for delete to authenticated using (owner_id = auth.uid());
drop policy if exists "trips: mark deleted or set cover if allowed" on public.trips;
create policy "trips: mark deleted or set cover if allowed" on public.trips for update to anon, authenticated
  using (public.can_access_trip(id)) with check (public.can_access_trip(id));
revoke update on public.trips from anon, authenticated;
grant update (deleted_at, cover_url) on public.trips to anon, authenticated;

-- trip_members: each person sees their own memberships
drop policy if exists "members: own rows" on public.trip_members;
create policy "members: own rows" on public.trip_members for select to authenticated using (user_id = auth.uid());
drop policy if exists "members: leave" on public.trip_members;
create policy "members: leave" on public.trip_members for delete to authenticated using (user_id = auth.uid());

-- versions
drop policy if exists "anyone can read versions" on public.itinerary_versions;
drop policy if exists "anyone can insert a new version" on public.itinerary_versions;
drop policy if exists "versions: read if allowed" on public.itinerary_versions;
create policy "versions: read if allowed" on public.itinerary_versions for select to anon, authenticated using (public.can_access_trip(trip_id));
drop policy if exists "versions: add if allowed" on public.itinerary_versions;
create policy "versions: add if allowed" on public.itinerary_versions for insert to anon, authenticated with check (public.can_access_trip(trip_id));
drop policy if exists "versions: prune if allowed" on public.itinerary_versions;
create policy "versions: prune if allowed" on public.itinerary_versions for delete to anon, authenticated using (public.can_access_trip(trip_id));

-- AI notes
drop policy if exists "anyone can read ai notes" on public.ai_notes;
drop policy if exists "anyone can add an ai note" on public.ai_notes;
drop policy if exists "anyone can delete an ai note" on public.ai_notes;
drop policy if exists "notes: read if allowed" on public.ai_notes;
create policy "notes: read if allowed" on public.ai_notes for select to anon, authenticated using (public.can_access_trip(trip_id));
drop policy if exists "notes: add if allowed" on public.ai_notes;
create policy "notes: add if allowed" on public.ai_notes for insert to anon, authenticated with check (public.can_access_trip(trip_id));
drop policy if exists "notes: delete if allowed" on public.ai_notes;
create policy "notes: delete if allowed" on public.ai_notes for delete to anon, authenticated using (public.can_access_trip(trip_id));

-- Names, pictures and people (applied together with accounts).
--
-- Each account has a display name and a small picture (kept in the row as
-- a data: URL the app shrinks to ~96px, so no storage bucket is needed).
-- A profile is only ever shown to people who share a trip with its owner,
-- through the functions below; the table itself is private to each person.
--
-- "Contacts" are the people you have already been on a trip with: once
-- someone has joined one of your trips (by a share link, logged in), you
-- can put them on a new trip directly and it appears in their list.
-- (public.profiles belongs to another app in this project, hence the name.)

create table if not exists public.trip_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 40),
  avatar text not null default '' check (char_length(avatar) <= 60000),
  updated_at timestamptz not null default now()
);
alter table public.trip_profiles enable row level security;
drop policy if exists "profile: read own" on public.trip_profiles;
create policy "profile: read own" on public.trip_profiles for select to authenticated using (user_id = auth.uid());
drop policy if exists "profile: create own" on public.trip_profiles;
create policy "profile: create own" on public.trip_profiles for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "profile: change own" on public.trip_profiles;
create policy "profile: change own" on public.trip_profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- name and picture for a set of accounts (falls back to the Google name)
create or replace function public.trip_person(uid uuid) returns json
language sql stable security definer set search_path = public, auth as $$
  select json_build_object(
    'id', u.id,
    'name', coalesce(nullif(p.display_name, ''), u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)),
    'avatar', coalesce(nullif(p.avatar, ''), u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture', ''))
  from auth.users u left join public.trip_profiles p on p.user_id = u.id
  where u.id = uid
$$;
revoke execute on function public.trip_person(uuid) from public, anon, authenticated;

-- who is on a trip: the owner first, then members (for anyone who can open it)
create or replace function public.trip_people(tid bigint) returns json
language sql stable security definer set search_path = public as $$
  select case when not public.can_access_trip(tid) then '[]'::json else coalesce((
    select json_agg(x.person order by x.ord, x.joined) from (
      select (public.trip_person(t.owner_id)::jsonb || '{"role":"owner"}'::jsonb) as person, 0 as ord, t.created_at as joined
        from public.trips t where t.id = tid and t.owner_id is not null
      union all
      select (public.trip_person(m.user_id)::jsonb || '{"role":"member"}'::jsonb), 1, m.joined_at
        from public.trip_members m where m.trip_id = tid
    ) x), '[]'::json) end
$$;

-- people I have been on a trip with
create or replace function public.my_trip_contacts() returns json
language sql stable security definer set search_path = public as $$
  with mine as (
    select id from public.trips where owner_id = auth.uid()
    union select trip_id from public.trip_members where user_id = auth.uid()
  ), people as (
    select owner_id as uid from public.trips where id in (select id from mine) and owner_id is not null
    union select user_id from public.trip_members where trip_id in (select id from mine)
  )
  select coalesce(json_agg(public.trip_person(uid)), '[]'::json) from people where uid <> auth.uid()
$$;

-- put a contact on a trip of mine (owner or member may), without a link
create or replace function public.add_trip_member(tid bigint, uid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if not exists (select 1 from public.trips t where t.id = tid and (t.owner_id = auth.uid()
      or exists (select 1 from public.trip_members m where m.trip_id = tid and m.user_id = auth.uid()))) then return false; end if;
  -- only someone I have already shared a trip with
  if not exists (
    select 1 from public.trips t where t.owner_id = auth.uid() and exists (select 1 from public.trip_members m where m.trip_id = t.id and m.user_id = uid)
    union all select 1 from public.trips t where t.owner_id = uid and exists (select 1 from public.trip_members m where m.trip_id = t.id and m.user_id = auth.uid())
    union all select 1 from public.trip_members a join public.trip_members b on a.trip_id = b.trip_id where a.user_id = auth.uid() and b.user_id = uid
  ) then return false; end if;
  if exists (select 1 from public.trips where id = tid and owner_id = uid) then return true; end if;
  insert into public.trip_members (trip_id, user_id) values (tid, uid) on conflict do nothing;
  return true;
end $$;

-- the owner takes someone off a trip
create or replace function public.remove_trip_member(tid bigint, uid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from public.trip_members where trip_id = tid and user_id = uid
    and exists (select 1 from public.trips where id = tid and owner_id = auth.uid());
  return found;
end $$;

grant execute on function public.trip_people(bigint) to anon, authenticated;
grant execute on function public.my_trip_contacts(), public.add_trip_member(bigint, uuid), public.remove_trip_member(bigint, uuid) to authenticated;

-- Leaving: removes the caller's login, name and picture. Their trips either
-- stay (ownerless again, so they can be claimed after signing up afresh)
-- or go with the account.
create or replace function public.delete_my_account(keep_trips boolean default true) returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := auth.uid();
begin
  if me is null then return false; end if;
  if keep_trips then update public.trips set owner_id = null where owner_id = me;
  else delete from public.trips where owner_id = me; end if;
  delete from auth.users where id = me;
  return true;
end $$;
revoke execute on function public.delete_my_account(boolean) from public, anon;
grant execute on function public.delete_my_account(boolean) to authenticated;

commit;
