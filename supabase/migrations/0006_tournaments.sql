-- ChainMate — Tournament engine (Phase 2A: free tournaments only)
-- ================================================================
-- Idempotent, additive. Pairs with lib/server/tournament-store.ts, which
-- mirrors the fast-store tournament documents here best-effort; the fast
-- store (KV / file store) stays the source of truth at runtime and this
-- schema is the cold-start recovery + durable record layer.
--
-- PAYMENT BOUNDARY: `tournaments.entry_fee_nim` is a nullable RESERVED
-- column for Phase 2B. Nothing in this phase writes or reads it — every row
-- carries NULL. There are no balances, no prize pools, no payouts, and no
-- wallet fields anywhere in this migration.

-- ---------------------------------------------------------------------------
-- Tournaments
-- ---------------------------------------------------------------------------
create table if not exists public.tournaments (
  id text primary key,
  name text not null,
  description text not null default '',
  creator_player_id text not null,
  format text not null check (format in ('knockout', 'swiss', 'arena')),
  time_control text not null,
  max_players integer not null check (max_players between 2 and 128),
  status text not null check (status in
    ('draft', 'registration', 'locked', 'in_progress', 'completed', 'cancelled')),
  swiss_rounds integer,
  registration_closes_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  current_round integer not null default 0,
  total_rounds integer not null default 0,
  winner_player_id text,
  -- Phase 2B reservation. Nullable, never written by Phase 2A code.
  entry_fee_nim numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournaments_status_idx
  on public.tournaments (status);
create index if not exists tournaments_creator_idx
  on public.tournaments (creator_player_id);
create index if not exists tournaments_created_idx
  on public.tournaments (created_at desc);

-- ---------------------------------------------------------------------------
-- Tournament entries (join records; one row per player per tournament)
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_entries (
  tournament_id text not null references public.tournaments (id) on delete cascade,
  player_id text not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  withdrawn boolean not null default false,
  primary key (tournament_id, player_id)
);

create index if not exists tournament_entries_player_idx
  on public.tournament_entries (player_id);

-- ---------------------------------------------------------------------------
-- Tournament matches (each references an existing hosted ChainMate game)
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_matches (
  id text primary key,
  tournament_id text not null references public.tournaments (id) on delete cascade,
  round integer not null default 0,
  slot integer not null default 0,
  white_player_id text not null,
  black_player_id text not null,
  game_id text not null default '',
  status text not null default 'active' check (status in ('pending', 'active', 'complete')),
  result text check (result in ('white', 'black', 'draw')),
  result_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists tournament_matches_tournament_idx
  on public.tournament_matches (tournament_id, round, slot);
create index if not exists tournament_matches_game_idx
  on public.tournament_matches (game_id);

-- ---------------------------------------------------------------------------
-- Standings snapshot (the server's last computed table per tournament)
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_standings (
  tournament_id text primary key references public.tournaments (id) on delete cascade,
  standings jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security — same model as the rest of ChainMate: public read,
-- service-role-only writes (all tournament mutations go through the API,
-- which authenticates with resolveActingPlayer and writes with the admin key).
-- ---------------------------------------------------------------------------
alter table public.tournaments enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.tournament_matches enable row level security;
alter table public.tournament_standings enable row level security;

drop policy if exists "tournaments are publicly readable" on public.tournaments;
create policy "tournaments are publicly readable"
  on public.tournaments for select using (true);

drop policy if exists "tournament entries are publicly readable" on public.tournament_entries;
create policy "tournament entries are publicly readable"
  on public.tournament_entries for select using (true);

drop policy if exists "tournament matches are publicly readable" on public.tournament_matches;
create policy "tournament matches are publicly readable"
  on public.tournament_matches for select using (true);

drop policy if exists "tournament standings are publicly readable" on public.tournament_standings;
create policy "tournament standings are publicly readable"
  on public.tournament_standings for select using (true);
