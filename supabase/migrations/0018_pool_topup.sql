-- ChainMate — prize-pool top-ups (admin console)
-- ==============================================
-- Idempotent, additive. Extends the nimiq_transactions consumption ledger's
-- `kind` vocabulary so a verified incoming transaction can be consumed as a
-- POOL TOP-UP — the operator (or host) adding prize money to a paid
-- tournament's pool from their own Nimiq Pay wallet, verified on-chain
-- exactly like an entry payment (sender tier checks, exact amount, executed,
-- ≥ required confirmations, durable replay guard).
--
-- Why the schema change: 0008 declared
--   check (kind in ('verification', 'tournament_entry'))
-- and no later migration widened it, so every 'refund' consumption row the
-- host-wallet refund path wrote (lib/server/tournament-refunds-wallet.ts)
-- SILENTLY FAILED its Supabase mirror (non-duplicate errors are swallowed)
-- even though the fast store kept it. This migration widens the check to the
-- full vocabulary the code already writes:
--
--   verification      wallet-link verification (Phase 1B)
--   tournament_entry  a player's verified entry fee (2B)
--   refund            a verified entry-fee RETURN paid by the host
--   pool_topup        a verified prize-pool top-up paid by the operator
--
-- There are still NO balances and NO custodial ledger here: every row
-- remains one real, verified on-chain transaction, and the
-- UNIQUE (network, tx_hash) replay guard is untouched. Pool top-ups count
-- toward a tournament's verified prize pool (they carry its tournament_id
-- and kind='pool_topup'); refunds never do (money OUT, never IN).

do $$
declare
  r record;
begin
  -- Drop whichever check constraint currently guards nimiq_transactions.kind
  -- (the auto-named one from 0008, or any re-created variant), then re-add a
  -- single named constraint with the full vocabulary. Drop-guard keeps
  -- RUN_ALL.sql re-runnable.
  for r in
    select conname from pg_constraint
    where conrelid = 'public.nimiq_transactions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.nimiq_transactions drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.nimiq_transactions
  add constraint nimiq_transactions_kind_check
  check (kind in ('verification', 'tournament_entry', 'refund', 'pool_topup'));

-- Top-up lookup: "which verified top-ups landed on tournament X?" (mirrors
-- the entry-lookup index; the kind filter is partial-index style.)
create index if not exists nimiq_tx_pool_topup_idx
  on public.nimiq_transactions (tournament_id, created_at)
  where kind = 'pool_topup';
