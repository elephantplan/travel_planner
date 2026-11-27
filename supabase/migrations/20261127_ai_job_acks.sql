-- 「AI 做好咗」notifications: a phone that saw the answer on screen says so
-- here, and trip-push then skips the notification. Only the edge functions
-- (service role) touch it.
create table if not exists public.ai_job_acks (
  job text primary key,
  created_at timestamptz not null default now()
);
alter table public.ai_job_acks enable row level security;
revoke all on public.ai_job_acks from anon, authenticated;
