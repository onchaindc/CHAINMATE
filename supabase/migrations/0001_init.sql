-- ChainMate — identity & progression schema
-- ===========================================
-- Run this once in your Supabase project (Dashboard → SQL Editor → New query,
-- paste, Run). It is idempotent (safe to run again).
--
-- Design notes:
--  * player_id is the game-store identity (a device guest id or the account's
--    fresh `acct_…` player id). user_id links the profile to Supabase Auth
--    for accounts; guests keep user_id NULL until they create an account.
--    Accounts always start fresh — guest history is never merged, so an
--    account's player_id is never a guest id.
--  * All writes go through the service-role key (bypasses RLS). Clients can
--    only SELECT — they can never edit ratings, results or achievements.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  player_id text not null unique,
  username text not null,
  is_guest boolean not null default true,
  rating integer not null default 1200,
  peak_rating integer not null default 1200,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  games integer not null default 0,
  current_streak integer not null default 0,
  best_streak integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Usernames are unique case-insensitively (ChainMate vs chainmate → conflict).
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- Game history (completed games mirrored from the game store)
-- ---------------------------------------------------------------------------
create table if not exists public.games (
  id text primary key,
  white_player_id text not null,
  black_player_id text not null,
  time_control text,
  status text not null,
  result text,
  winner_player_id text not null default '',
  created_at bigint not null,
  started_at bigint,
  ended_at bigint,
  moves jsonb not null default '[]',
  summary text not null default '',
  synced_at timestamptz not null default now()
);

create index if not exists games_white_idx on public.games (white_player_id);
create index if not exists games_black_idx on public.games (black_player_id);
create index if not exists games_ended_idx on public.games (ended_at desc);

-- ---------------------------------------------------------------------------
-- Achievements (server-written only)
-- ---------------------------------------------------------------------------
create table if not exists public.player_achievements (
  player_id text not null,
  code text not null,
  earned_at bigint not null,
  primary key (player_id, code)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.player_achievements enable row level security;

-- Public read: profiles (leaderboard, public profiles), games (watch /
-- replay), achievements. No insert/update/delete policies exist — only the
-- service-role key (which bypasses RLS) can write.
create policy "profiles are publicly readable"
  on public.profiles for select using (true);

create policy "games are publicly readable"
  on public.games for select using (true);

create policy "achievements are publicly readable"
  on public.player_achievements for select using (true);
