-- ChainMate — durable game snapshots
-- ===================================
-- Run this once in Supabase (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent — safe to run again.

-- Full game-state snapshot (fen, moves, commentary, draw offers, visibility…)
-- is written on every game mutation, so a live match can be recovered from
-- the database even if the fast game store (KV / file store) loses the game.
-- This is what fixes "Game not found" mid-game on serverless hosts.
alter table public.games add column if not exists snapshot jsonb;

-- Used to rebuild the live Watch feed and the game index after a storage
-- reset (active games for Watch, recent games for Games / homepage).
create index if not exists games_status_idx on public.games (status);
create index if not exists games_created_idx on public.games (created_at desc);
