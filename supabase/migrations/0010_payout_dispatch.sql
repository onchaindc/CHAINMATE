-- ChainMate — treasury payout dispatch (Phase 3B)
-- ================================================
-- Idempotent, additive. Builds on 0009 (tournament_payouts state machine).
-- Gives the payout ledger the durable metadata a REAL on-chain dispatch
-- needs, so a crash at any point can be recovered without ever paying twice:
--
--   network                 which chain this payout dispatch ran on
--   sender_address          the treasury address the node signs from
--   validity_start_height   the WRITE-AHEAD dispatch record — see below
--   dispatch_attempts       how many broadcast attempts were made
--   last_broadcast_at       when the most recent attempt was sent
--   status 'dispatching'    broadcast intent recorded, outcome unknown
--
-- THE CRASH-SAFETY STORY (why validity_start_height is the whole point):
-- Nimiq transactions are a PURE function of their fields — sender, recipient,
-- value, fee, validity_start_height, network — and ed25519 signing is
-- deterministic (RFC 8032). Two broadcasts with identical fields produce a
-- byte-identical transaction and therefore the SAME hash; the chain itself
-- rejects/ignores the duplicate (mempool dedupe + validity-store replay
-- window). So the recovery protocol after a crash between "broadcast sent"
-- and "hash persisted" is to re-broadcast with the SAME recorded
-- validity_start_height: either the original went out (duplicate is deduped
-- on-chain) or it never left (this is its first broadcast). Either way,
-- EXACTLY ONE effective payment exists. No hash guessing, no balance math.

-- ---------------------------------------------------------------------------
-- 1. Dispatch metadata columns
-- ---------------------------------------------------------------------------
alter table public.tournament_payouts
  add column if not exists network text
    check (network in ('main', 'test')),
  add column if not exists sender_address text,
  add column if not exists validity_start_height integer
    check (validity_start_height >= 0),
  add column if not exists dispatch_attempts integer not null default 0
    check (dispatch_attempts >= 0),
  add column if not exists last_broadcast_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Extend the status state machine with the write-ahead 'dispatching' state
--    (0009 declared the check inline, so its name is generated — look it up.)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tournament_payouts_status_check'
      and conrelid = 'public.tournament_payouts'::regclass
  ) then
    -- The generated name differs; find whichever check constrains status.
    for r in
      select conname from pg_constraint
      where conrelid = 'public.tournament_payouts'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%status%'
        and pg_get_constraintdef(oid) like '%pending%'
    loop
      execute format('alter table public.tournament_payouts drop constraint %I', r.conname);
      exit;
    end loop;
  else
    alter table public.tournament_payouts
      drop constraint tournament_payouts_status_check;
  end if;
end $$;

alter table public.tournament_payouts
  add constraint tournament_payouts_status_check
  check (status in
    ('pending', 'dispatching', 'sent', 'verified', 'failed', 'blocked_no_wallet'));

-- A 'dispatching' row is a broadcast INTENT: it must already know exactly what
-- it intends to send — destination, amount, sender, validity start height.
alter table public.tournament_payouts
  add constraint payout_dispatching_is_complete_intent
  check (
    status <> 'dispatching'
    or (
      destination_address is not null
      and amount_luna is not null
      and sender_address is not null
      and validity_start_height is not null
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Durable duplicate protection: an outgoing payout hash can be used ONCE
--    per network, ever. Combined with the entry-ledger uniqueness this makes
--    "same tx pays twice" impossible at the schema level, not just in code.
-- ---------------------------------------------------------------------------
create unique index if not exists tournament_payouts_tx_hash_unique
  on public.tournament_payouts (network, payout_tx_hash)
  where payout_tx_hash is not null;

-- Fast lookup for the reconciler: everything currently mid-dispatch.
create index if not exists tournament_payouts_dispatching_idx
  on public.tournament_payouts (status)
  where status = 'dispatching';
