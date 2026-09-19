-- ChainMate — durable admin bans (restriction ledger)
-- =====================================================
-- Idempotent, additive. Pairs with lib/server/admin.ts: the fast store
-- (.data / Vercel KV) is the runtime source of truth and this table is the
-- durable mirror used for cold-start recovery. Without it, a fresh
-- serverless instance started with an empty fast store and every
-- restriction silently vanished — restricted accounts could simply wait
-- out a redeploy and play again. Mirrors the wallet-binding pattern from
-- 0007 exactly.
--
-- SCOPE BOUNDARY: administrative restrictions only. No balances, payouts,
-- or payments live here.

create table if not exists public.admin_bans (
  player_id text primary key,
  reason text not null,
  banned_by text not null,
  banned_at timestamptz not null default now()
);

-- Mirror writes go through the service-role key only.
alter table public.admin_bans enable row level security;

-- No policies: anon/authenticated clients are denied every operation;
-- the API (service key) bypasses RLS as intended.
