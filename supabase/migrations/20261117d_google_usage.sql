-- Google API calls the edge functions make, counted per day and per billing
-- tier (sku), so the admin page can show this month's use against Google's
-- free monthly allowance. Written only by the edge functions (service role).
create table if not exists public.google_usage (
  day date not null default current_date,
  sku text not null,
  calls integer not null default 0,
  primary key (day, sku)
);
alter table public.google_usage enable row level security;

create or replace function public.bump_google_usage(p_sku text, p_n integer default 1) returns void
language sql security definer set search_path = public as $$
  insert into public.google_usage (day, sku, calls) values (current_date, p_sku, greatest(p_n, 1))
  on conflict (day, sku) do update set calls = public.google_usage.calls + excluded.calls;
$$;
revoke all on function public.bump_google_usage(text, integer) from public, anon, authenticated;
grant execute on function public.bump_google_usage(text, integer) to service_role;

-- admin page: calls per sku for one month, and per day for the chart
create or replace function public.admin_google_usage(p_month date default date_trunc('month', current_date)::date) returns json
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_trip_admin() then raise exception 'not an admin' using errcode = '42501'; end if;
  return json_build_object(
    'month', to_char(p_month, 'YYYY-MM'),
    'skus', coalesce((select json_agg(x order by x.calls desc) from (
      select sku, sum(calls)::int as calls from public.google_usage
      where day >= p_month and day < (p_month + interval '1 month') group by sku) x), '[]'::json),
    'days', coalesce((select json_agg(x order by x.day) from (
      select day, sum(calls)::int as calls from public.google_usage
      where day >= p_month and day < (p_month + interval '1 month') group by day) x), '[]'::json));
end $$;
revoke all on function public.admin_google_usage(date) from public, anon;
grant execute on function public.admin_google_usage(date) to authenticated;
