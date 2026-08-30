-- 麻雀計分 Supabase schema（已經套咗落 project fhmrktvyekrbbhgpipvv）
-- 讀：任何人有 room code 都得。寫：一律經下面嘅 RPC，要 host key 先做得到。
create extension if not exists pgcrypto;

create table public.games (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  ruleset jsonb not null,
  status text not null default 'active' check (status in ('active','finished')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- host key 只留 hash，而且擺喺一張冇 policy 嘅表，經 API 讀唔到
create table public.game_secrets (
  game_id uuid primary key references public.games(id) on delete cascade,
  host_key_hash text not null
);

-- 換人 = 舊 row 封 to_seq，開新 row 由嗰刻計起
create table public.seats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  seat int not null check (seat between 0 and 3),
  player_name text not null,
  from_seq int not null default 0,
  to_seq int,
  created_at timestamptz not null default now()
);
create index seats_game_idx on public.seats(game_id, seat);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('win','draw','false_win')),
  winner_seat int check (winner_seat between 0 and 3),
  loser_seat int check (loser_seat between 0 and 3),
  fan int,
  fan_types jsonb not null default '[]'::jsonb,
  deltas numeric[] not null,
  note text,
  created_at timestamptz not null default now(),
  unique (game_id, seq)
);
create index rounds_game_idx on public.rounds(game_id, seq);

alter table public.games        enable row level security;
alter table public.game_secrets enable row level security;  -- 冇 policy = 完全讀唔到
alter table public.seats        enable row level security;
alter table public.rounds       enable row level security;

create policy games_read  on public.games  for select to anon, authenticated using (true);
create policy seats_read  on public.seats  for select to anon, authenticated using (true);
create policy rounds_read on public.rounds for select to anon, authenticated using (true);

alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.seats;
alter publication supabase_realtime add table public.rounds;

-- ── Functions ─────────────────────────────────────────────
-- 完整定義見資料庫（pg_get_functiondef）；下面係同一份邏輯嘅摘要：
--   fan_amount(ruleset, fan)                 番數 -> 金額（夾喺起糊同封頂之間）
--   settle_round(ruleset, kind, w, l, fan)   一局四家加減（總和必為 0）
--   assert_host(room, host_key)              核對 host key，唔啱就 raise（唔開放俾 API）
--   create_game(ruleset, names[], host_key)  開局，回傳 room_code
--   add_round(room, host_key, kind, ...)     入一局（金額喺 DB 計，唔信前端）
--   undo_last_round(room, host_key)          撤銷最後一局
--   substitute_player(room, host_key, seat, name)  換人
--   finish_game / reopen_game(room, host_key)      結束 / 重開牌局
-- 除咗 assert_host，其餘 grant execute 俾 anon + authenticated；
-- 全部 SECURITY DEFINER + set search_path，寫入前一律行 assert_host。
