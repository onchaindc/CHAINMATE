-- ChainMate — Nimiq wallet identity binding (Phase 1B)
-- =====================================================
-- Idempotent, additive. Pairs with lib/server/nimiq/store.ts, which keeps the
-- fast store (KV / file store) as the runtime source of truth and mirrors
-- bindings + challenges here best-effort; this schema is the durable record
-- layer and the cold-start recovery source for the address-uniqueness index.
--
-- SCOPE BOUNDARY: identity binding only. There are no balances, transactions,
-- deposits, withdrawals, prizes, payouts, or treasury tables here — those
-- belong to later phases and none are reserved by this migration.
--
-- Public key is kept for verification/audit: the bound address must always be
-- the Blake2b-256-derived address OF this public key (re-derivable offline).

-- ---------------------------------------------------------------------------
-- One wallet per player (player_id is the primary key), one player per wallet
-- (address is globally unique). Canonical address form: uppercase, spaces
-- stripped (36 chars, "NQ" + 2 check digits + 32 base32 chars).
-- ---------------------------------------------------------------------------
create table if not exists public.nimiq_wallet_bindings (
  player_id text primary key references public.profiles (player_id) on delete cascade,
  address text not null unique,
  network text not null check (network in ('main', 'test')),
  public_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nimiq_wallet_bindings_network_idx
  on public.nimiq_wallet_bindings (network);

-- ---------------------------------------------------------------------------
-- Server-issued, single-use link challenges. A challenge is cryptographically
-- random (32 bytes, hex-encoded), bound to one player + one network, and
-- consumed exactly once within its short expiry window. Only the service role
-- reads/writes this table: RLS is enabled with NO policies, so anon and
-- authenticated clients are denied while the API (service key) proceeds.
-- ---------------------------------------------------------------------------
create table if not exists public.nimiq_wallet_challenges (
  nonce text primary key,
  player_id text not null references public.profiles (player_id) on delete cascade,
  network text not null check (network in ('main', 'test')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists nimiq_wallet_challenges_player_idx
  on public.nimiq_wallet_challenges (player_id);
create index if not exists nimiq_wallet_challenges_expiry_idx
  on public.nimiq_wallet_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.nimiq_wallet_bindings enable row level security;
alter table public.nimiq_wallet_challenges enable row level security;

-- Bindings are public read (a wallet address is public chain data, and the
-- app's profiles/leaderboard are public too); every write goes through the
-- authenticated API with the service-role key. Drop guard keeps RUN_ALL
-- re-runnable.
drop policy if exists "nimiq wallet bindings are publicly readable" on public.nimiq_wallet_bindings;
create policy "nimiq wallet bindings are publicly readable"
  on public.nimiq_wallet_bindings for select using (true);

-- Challenges carry single-use secrets: no client-facing policies at all.
