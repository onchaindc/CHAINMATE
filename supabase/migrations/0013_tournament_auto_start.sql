-- ChainMate — tournament auto-start-when-full flag
-- ============================================================
-- Idempotent, additive. Builds on 0006/0009/0010/0011/0012.
--
-- start_when_full records the host's choice at creation: when the field
-- reaches maxPlayers during registration the engine locks the field and
-- starts the event immediately (instead of waiting for the scheduled start
-- or a manual host action). Default FALSE — the historical behaviour
-- ("Full — starts when registration closes") is preserved for existing rows.

alter table public.tournaments
  add column if not exists start_when_full boolean not null default false;
