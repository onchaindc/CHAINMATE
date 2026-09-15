-- ChainMate — Nimiq transaction consumption ledger (Phase 1C)
-- ===========================================================
-- Idempotent, additive. Pairs with lib/server/nimiq/transactions.ts, which
-- verifies a REAL transaction through the configured Nimiq node and records
-- it here exactly once. This table is REPLAY PROTECTION + AUDIT only:
--
--   * no balances, no credits, no custodial ledger
--   * no payouts, no prize accounting, no treasury movements
--   * rows are written only after every verification check passes
--
-- The UNIQUE (network, tx_hash) constraint is the final durable protection
-- against accepting the same on-chain transaction twice — it holds across
-- server instances and restarts, unlike any in-memory set.

create table if not exists public.nimiq_transactions (
  id bigserial primary key,
  network text not null check (network in ('main', 'test')),
  -- Canonical tx hash as returned by the node (lowercase hex).
  tx_hash text not null,
  player_id text not null references public.profiles (player_id) on delete cascade,
  -- What the transaction was consumed FOR. Phase 1C only ever writes
  -- 'verification'; tournament entry fees (2B) will write 'tournament_entry'.
  kind text not null default 'verification'
    check (kind in ('verification', 'tournament_entry')),
  -- Reserved for Phase 2B: which tournament a consumed transaction paid for.
  -- Nullable; never written by Phase 1C code.
  tournament_id text,
  sender text not null,
  recipient text not null,
  -- Luna as an EXACT decimal string (digits only, no sign, no exponent).
  -- Never numeric/float: luna must survive JSON round-trips bit-exact.
  amount_luna text not null check (amount_luna ~ '^[0-9]+$'),
  block_number bigint not null check (block_number >= 0),
  -- Confirmations observed at verification time (audit snapshot).
  confirmations integer not null check (confirmations >= 0),
  verified_at timestamptz not null default now(),
  consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- The durable replay guard: one consumption per on-chain transaction
  -- per network (main/test hashes could theoretically collide).
  unique (network, tx_hash)
);

create index if not exists nimiq_transactions_player_idx
  on public.nimiq_transactions (player_id);
create index if not exists nimiq_transactions_kind_idx
  on public.nimiq_transactions (kind);
-- Future tournament lookup: "which entries paid for tournament X?"
create index if not exists nimiq_transactions_tournament_idx
  on public.nimiq_transactions (tournament_id)
  where tournament_id is not null;
create index if not exists nimiq_transactions_created_idx
  on public.nimiq_transactions (created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — service-role only writes (all consumption flows through
-- the authenticated API); read access is deliberately withheld from clients:
-- consumption records contain treasury flows and must not be enumerable.
-- ---------------------------------------------------------------------------
alter table public.nimiq_transactions enable row level security;
