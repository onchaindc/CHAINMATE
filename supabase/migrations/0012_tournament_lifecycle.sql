-- ChainMate — tournament lifecycle completion (deadline, minimum field,
-- refunds, arena window, knockout tiebreaks)
-- ============================================================================
-- Idempotent, additive. Builds on 0006/0009/0010/0011_schedule. Adds:
--
--   1. tournaments.scheduled_end_at   — arena (and any format's) hard end
--   2. tournaments.cancel_reason      — why an event was cancelled
--   3. tournaments.min_players        — deadline rule: max(2, prize positions)
--   4. tournaments.payout_status gains 'refunded' (fully refunded cancellation)
--   5. public.tournament_refunds — the durable refund ledger
--
-- REFUND FINANCIAL INVARIANTS (schema-level, like 0009/0010):
--   * one refund row per (tournament, player) — a retry cannot create two
--   * one refund per entry tx — the money returns exactly once
--   * amount equals the verified entry amount (digits-only luna, exact)
--   * status machine: owed → dispatched → verified (failed is retryable back
--     to owed; 'dispatched' is the write-ahead intent, see 0010's protocol)
-- ============================================================================

alter table public.tournaments
  add column if not exists scheduled_end_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists min_players integer
    check (min_players is null or min_players >= 0);

-- Extend the aggregate payout status with the fully-refunded state.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'tournaments_payout_status_check'
      and conrelid = 'public.tournaments'::regclass
  ) then
    alter table public.tournaments
      drop constraint tournaments_payout_status_check;
  elsif exists (
    select 1 from pg_constraint
    where conrelid = 'public.tournaments'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%payout_status%'
  ) then
    -- 0009 declared the check inline with a generated name: drop whichever
    -- check constrains payout_status.
    declare
      r record;
    begin
      for r in
        select conname from pg_constraint
        where conrelid = 'public.tournaments'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%payout_status%'
      loop
        execute format('alter table public.tournaments drop constraint %I', r.conname);
        exit;
      end loop;
    end;
  end if;
end $$;

alter table public.tournaments
  add constraint tournaments_payout_status_check
  check (payout_status in
    ('none', 'pending', 'partial', 'paid', 'refund_required', 'refunded'));

-- The durable refund ledger.
create table if not exists public.tournament_refunds (
  id bigserial primary key,
  tournament_id text not null
    references public.tournaments (id) on delete cascade,
  player_id text not null,
  -- The verified entry tx this refund returns (from nimiq_transactions).
  entry_tx_hash text not null,
  -- Exact luna returned: always exactly what the entry paid.
  amount_luna text not null check (amount_luna ~ '^[0-9]+$'),
  -- OWED → DISPATCHED → VERIFIED; FAILED is retryable back to owed.
  status text not null default 'owed'
    check (status in ('owed', 'dispatched', 'verified', 'failed')),
  refund_tx_hash text,
  validity_start_height integer,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

-- Refund records are who was paid back and how much: financial data. RLS on,
-- no policies, so anon/authenticated clients can read nothing directly; the
-- service role (the only writer/reader, via the server routes) bypasses RLS.
alter table public.tournament_refunds enable row level security;

-- One refund per player per tournament, ever.
create unique index if not exists tournament_refunds_one_per_player
  on public.tournament_refunds (tournament_id, player_id);

-- One refund per entry tx, ever (the same payment cannot be refunded twice,
-- even across tournaments — an entry tx pays one tournament, so this is
-- belt-and-braces over the (tournament, player) uniqueness).
create unique index if not exists tournament_refunds_one_per_tx
  on public.tournament_refunds (entry_tx_hash);

-- Dispatch queue lookup for the reconciler.
create index if not exists tournament_refunds_owed_idx
  on public.tournament_refunds (tournament_id, status)
  where status in ('owed', 'dispatching', 'dispatched');
