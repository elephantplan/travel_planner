-- 1. Creating a trip failed (403): the app asks for the new row back, and the
--    read policy looked the row up through a function, which cannot see a row
--    its own statement has just inserted. The policy now tests the row itself.
-- 2. Admins: a page to see and edit accounts (admin.html). An admin does not
--    see other people's trips' contents, only who owns which.
-- Who the first admin is, is set when this is run (see RUN_ME_2), not here.

drop policy if exists "trips: read if allowed" on public.trips;
create policy "trips: read if allowed" on public.trips for select to anon, authenticated using (
  owner_id is null or owner_id = auth.uid() or share_token::text = public.trip_share_header()
  or exists (select 1 from public.trip_members m where m.trip_id = id and m.user_id = auth.uid()));

create table if not exists public.trip_admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.trip_admins enable row level security;

create or replace function public.is_trip_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_admins where user_id = auth.uid())
$$;

create or replace function public.admin_users() returns json
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.created_at) from (
    select u.id, u.email, u.created_at, u.last_sign_in_at,
      coalesce(nullif(p.display_name, ''), u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)) as name,
      coalesce(p.display_name, '') as display_name,
      coalesce(nullif(p.avatar, ''), u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture', '') as avatar,
      exists (select 1 from public.trip_admins a where a.user_id = u.id) as is_admin,
      (select count(*) from public.trips t where t.owner_id = u.id and t.deleted_at is null) as trips,
      (select count(*) from public.trip_members m where m.user_id = u.id) as shared
    from auth.users u left join public.trip_profiles p on p.user_id = u.id) x), '[]'::json);
end $$;

create or replace function public.admin_trips() returns json
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  return coalesce((select json_agg(x order by x.date_start desc nulls last) from (
    select t.id, t.name, t.date_start, t.date_end, t.owner_id, t.deleted_at,
      (select count(*) from public.trip_members m where m.trip_id = t.id) as members
    from public.trips t) x), '[]'::json);
end $$;

create or replace function public.admin_set_user(uid uuid, new_name text, new_avatar text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  insert into public.trip_profiles (user_id, display_name, avatar) values (uid, left(coalesce(new_name, ''), 40), coalesce(new_avatar, ''))
  on conflict (user_id) do update set display_name = excluded.display_name,
    avatar = case when new_avatar is null then public.trip_profiles.avatar else excluded.avatar end, updated_at = now();
  return true;
end $$;

create or replace function public.admin_set_admin(uid uuid, make boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  if make then insert into public.trip_admins (user_id) values (uid) on conflict do nothing;
  elsif uid <> auth.uid() then delete from public.trip_admins where user_id = uid;   -- never the last one: not yourself
  else return false; end if;
  return true;
end $$;

create or replace function public.admin_set_trip_owner(tid bigint, uid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  update public.trips set owner_id = uid where id = tid;
  return found;
end $$;

create or replace function public.admin_delete_user(uid uuid, keep_trips boolean default true) returns boolean
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  if uid = auth.uid() then return false; end if;
  if keep_trips then update public.trips set owner_id = auth.uid() where owner_id = uid;   -- they go to the admin, never public
  else delete from public.trips where owner_id = uid; end if;
  delete from auth.users where id = uid;
  return true;
end $$;

revoke execute on function public.admin_users(), public.admin_trips(), public.admin_set_user(uuid, text, text), public.admin_set_admin(uuid, boolean),
  public.admin_set_trip_owner(bigint, uuid), public.admin_delete_user(uuid, boolean) from public, anon;
grant execute on function public.is_trip_admin(), public.admin_users(), public.admin_trips(), public.admin_set_user(uuid, text, text),
  public.admin_set_admin(uuid, boolean), public.admin_set_trip_owner(bigint, uuid), public.admin_delete_user(uuid, boolean) to authenticated;
