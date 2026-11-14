-- Change notifications are merged instead of sent one by one: each phone
-- keeps what it hasn't been told yet (pending), when it was last told
-- (last_notified), and how often it wants to be told (freq: 'batch' = at
-- most every 30 minutes, 'daily' = one summary at 9pm Hong Kong time).
alter table public.push_subs add column if not exists pending jsonb not null default '[]'::jsonb;
alter table public.push_subs add column if not exists last_notified timestamptz;
alter table public.push_subs add column if not exists freq text not null default 'batch';
