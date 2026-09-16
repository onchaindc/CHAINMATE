-- ChainMate — tournament scheduling + host delete
-- ================================================
-- Idempotent, additive. Adds the scheduled-start instant (host picks a
-- future time; registration opens automatically when it arrives) to the
-- durable mirror of the tournament document. No payment semantics here.

alter table public.tournaments
  add column if not exists scheduled_start_at timestamptz;
