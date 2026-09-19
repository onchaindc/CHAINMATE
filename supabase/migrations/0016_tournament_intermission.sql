-- Round intermission: the engine schedules the NEXT round a short break after
-- the last game of the current round ends, instead of dealing it instantly.
-- next_round_at = the instant the next round will be generated (null = none
-- pending). Read by the cold-start rebuild path; the fast store stays the
-- source of truth.
alter table tournaments
  add column if not exists next_round_at timestamptz;
