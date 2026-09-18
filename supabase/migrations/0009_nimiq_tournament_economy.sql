-- ChainMate — Nimiq tournament economy (Phase 2B)
-- ================================================
-- Idempotent, additive. Builds on 0006 (tournaments), 0007 (wallet
-- bindings), 0008 (nimiq_transactions consumption ledger). Adds:
--
--   1. paid-tournament fields on public.tournaments
--      (entry fee in EXACT luna text, distribution preset, payout state)
--   2. durable uniqueness so a verified tx can pay for ONE tournament entry
--      exactly once (partial unique indexes over kind='tournament_entry')
--   3. public.tournament_payouts — the durable payout ledger / state machine
--
-- FINANCIAL INVARIANTS ENFORCED BY SCHEMA (not just code):
--   * a tx hash pays for at most one tournament entry (per network)
--   * a player has at most one paid entry per tournament
--   * luna is stored as digits-only text — never numeric/float
--   * payout amount >= 0; payouts are per tournament+player, one row each
--
-- There are NO balances, NO custodial ledger, NO fake money anywhere here.
-- Every luna value originates from a REAL on-chain tx verified through
-- verifyIncomingTransaction() (Phase 1C) before any row is written.

-- ---------------------------------------------------------------------------
-- 1. Paid tournament fields
-- ---------------------------------------------------------------------------
alter table public.tournaments
  add column if not exists entry_fee_luna text
    check (entry_fee_luna ~ '^[0-9]+$'),           -- digits-only, exact luna
  add column if not exists entry_fee_nim decimal(12, 5), -- human display copy
  add column if not exists prize_preset text
    check (prize_preset in ('winner', 'top3', 'top5')),
  add column if not exists payout_status text
    not null default 'none'
    check (payout_status in
      ('none', 'pending', 'partial', 'paid', 'refund_required'));

-- The old reserved column (0006) is superseded by the exact-luna column.
-- Keep it for drift safety but stop using it; drop it from new mental models.
comment on column public.tournaments.entry_fee_nim is
  'DEPRECATED Phase-2A reservation — display copy only; entry_fee_luna is authoritative.';

-- ---------------------------------------------------------------------------
-- 2. Entry-ledger uniqueness (durable, partial unique indexes on 0008 table)
-- ---------------------------------------------------------------------------
-- (a) One tx consumed as a tournament entry, ever (per network).
create unique index if not exists nimiq_tx_one_entry_per_tx
  on public.nimiq_transactions (network, tx_hash)
  where kind = 'tournament_entry';

-- (b) A tournament+tx pair can appear once (tx can't pay two tournaments).
--     Implied by (a), kept explicit for documentation value.
-- (c) One PAID entry per player per tournament.
create unique index if not exists nimiq_tx_one_entry_per_player
  on public.nimiq_transactions (tournament_id, player_id)
  where kind = 'tournament_entry' and tournament_id is not null;

-- Tournament lookup for prize-pool queries.
create index if not exists nimiq_tx_tournament_entry_idx
  on public.nimiq_transactions (tournament_id, created_at)
  where kind = 'tournament_entry';

-- ---------------------------------------------------------------------------
-- 3. Payout ledger — durable state machine
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_payouts (
  id bigserial primary key,
  tournament_id text not null
    references public.tournaments (id) on delete cascade,
  player_id text not null,
  -- Final standings rank this payout is for (1 = winner).
  payout_rank integer not null check (payout_rank >= 1),
  -- Share in basis points (10000 = 100%). Exact, never a float.
  share_bps integer not null check (share_bps between 0 and 10000),
  -- Exact luna, digits-only text.
  amount_luna text not null check (amount_luna ~ '^[0-9]+$'),
  -- Where the funds go: ALWAYS the Phase-1B verified binding, never a
  -- client-supplied address. Nullable while blocked_no_wallet.
  destination_address text,
  -- PENDING → SENT → VERIFIED; or BLOCKED_NO_WALLET; or FAILED (retryable).
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'verified', 'failed', 'blocked_no_wallet')),
  -- On-chain hash of the OUTGOING treasury payout, once one exists.
  -- NULL until a real signer is configured — never faked.
  payout_tx_hash text,
  sent_at timestamptz,
  verified_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One payout row per tournament per player.
  unique (tournament_id, player_id)
);

create index if not exists tournament_payouts_tournament_idx
  on public.tournament_payouts (tournament_id, payout_rank);
create index if not exists tournament_payouts_status_idx
  on public.tournament_payouts (status);
create index if not exists tournament_payouts_player_idx
  on public.tournament_payouts (player_id);

-- RLS: payouts contain treasury flows — read withheld from clients, writes
-- service-role only (all flows go through the authenticated API).
alter table public.tournament_payouts enable row level security;

-- Guard: a payout row can never be marked sent/verified without a real tx
-- hash. (Application code also enforces this; the check is the durable net.)
-- Drop guard first: Postgres has no ADD CONSTRAINT IF NOT EXISTS, and RUN_ALL
-- re-runs must converge instead of failing with 42710.
alter table public.tournament_payouts
  drop constraint if exists payout_sent_requires_hash;
alter table public.tournament_payouts
  add constraint payout_sent_requires_hash
  check (
    (status in ('sent', 'verified')) = (payout_tx_hash is not null)
  );
