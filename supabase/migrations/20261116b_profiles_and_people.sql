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
create policy "profile: read own" on public.trip_profiles for select to authenticated using (user_id = auth.uid());
create policy "profile: create own" on public.trip_profiles for insert to authenticated with check (user_id = auth.uid());
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
