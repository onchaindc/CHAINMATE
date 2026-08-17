-- ChainMate — identity, rating confidence & social layer
-- ========================================================
-- Run this once in Supabase (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent — safe to run again.

-- ---------------------------------------------------------------------------
-- Profiles: Glicko rating deviation + optional country
-- ---------------------------------------------------------------------------
-- rd (rating deviation) is the confidence behind a rating: new/inactive
-- players start at 350 (provisional) and settle toward 30 as they play.
-- last_played_at drives RD decay for inactive players. country is optional
-- and purely display (flag next to the username).
alter table public.profiles add column if not exists rd integer not null default 350;
alter table public.profiles add column if not exists last_played_at bigint;
alter table public.profiles add column if not exists country text;

-- ---------------------------------------------------------------------------
-- Friendships (real, persistent friend requests — never local UI state)
-- ---------------------------------------------------------------------------
-- status: pending (awaiting addressee) → accepted | rejected. Both players
-- are identified by their game-store player id so guests and accounts work
-- identically. The pair is unique in both directions (one row per pair).
create table if not exists public.friendships (
  id bigserial primary key,
  requester_player_id text not null,
  addressee_player_id text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at bigint not null,
  responded_at bigint,
  unique (requester_player_id, addressee_player_id)
);

create index if not exists friendships_addressee_idx
  on public.friendships (addressee_player_id, status);

create index if not exists friendships_requester_idx
  on public.friendships (requester_player_id, status);

alter table public.friendships enable row level security;

-- Public read so profiles can render friends lists (writes stay service-role
-- only, like every other trusted table).
create policy "friendships are publicly readable"
  on public.friendships for select using (true);
