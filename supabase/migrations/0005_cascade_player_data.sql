-- ChainMate — make account deletion actually cascade
-- ==================================================
-- Run once in Supabase (Dashboard → SQL Editor → New query, paste, Run).
-- Idempotent: safe to run again.
--
-- Run migration 0004 BEFORE this one.
--
-- Why this exists
-- ---------------
-- DELETE /api/players/me documents its behaviour as:
--
--   "Delete Supabase auth user — this cascades to profiles,
--    player_achievements, and friendships via FK constraints."
--
-- Only the first of those was ever true. Before this migration the entire
-- schema contained exactly one foreign key — profiles.user_id → auth.users —
-- so deleting an account removed the auth user and its profile row and left
-- every achievement and friendship behind, keyed to a player_id that no
-- longer resolves to anything. Deleted users kept appearing in other
-- players' friends lists.
--
-- Fix: real FKs from the player-scoped tables to profiles(player_id), with
-- ON DELETE CASCADE. profiles.player_id is `not null unique` in 0001 (and the
-- primary key after 0004), so it is a valid FK target either way. The delete
-- chain becomes:
--
--   auth.users → profiles → { player_achievements, friendships }
--
-- Note on public.games
-- --------------------
-- games is deliberately NOT given a cascading FK. A game is a shared record
-- between two players: cascading from one would destroy the opponent's
-- history too, and /watch and /games replay finished games indefinitely.
-- winner_player_id also defaults to '' (empty string, for draws/unfinished),
-- which no profile row can ever match, so it cannot carry an FK at all.
-- Game history intentionally outlives the accounts that produced it.

-- ---------------------------------------------------------------------------
-- 1. Report pre-existing orphans
-- ---------------------------------------------------------------------------
-- Rows whose player_id has no profiles row. These exist because the 0001
-- schema made guest profile inserts impossible (see 0004), so guest-owned
-- achievements and friendships were written with no profile to point at.
-- The counts are printed rather than acted on — nothing here deletes data.
do $$
declare
  orphan_ach integer;
  orphan_req integer;
  orphan_addr integer;
begin
  select count(*) into orphan_ach
    from public.player_achievements a
    where not exists (select 1 from public.profiles p where p.player_id = a.player_id);

  select count(*) into orphan_req
    from public.friendships f
    where not exists (select 1 from public.profiles p where p.player_id = f.requester_player_id);

  select count(*) into orphan_addr
    from public.friendships f
    where not exists (select 1 from public.profiles p where p.player_id = f.addressee_player_id);

  raise notice 'Orphaned rows — player_achievements: %, friendships.requester: %, friendships.addressee: %',
    orphan_ach, orphan_req, orphan_addr;

  if orphan_ach + orphan_req + orphan_addr > 0 then
    raise notice 'Constraints are added NOT VALID, so these rows are left in place. See step 3 to review and clean them up.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Add the cascading foreign keys
-- ---------------------------------------------------------------------------
-- NOT VALID is deliberate: it skips the one-time check against existing rows
-- (so this migration cannot fail on the orphans reported above and never
-- destroys data) while still enforcing the constraint on every subsequent
-- insert and update. ON DELETE CASCADE is a referential action and fires
-- regardless of validation state, so account deletion cascades correctly the
-- moment this runs — which is the bug being fixed.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'player_achievements'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'player_achievements_player_id_fkey'
  ) then
    alter table public.player_achievements
      add constraint player_achievements_player_id_fkey
      foreign key (player_id) references public.profiles (player_id)
      on delete cascade
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'friendships'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'friendships_requester_player_id_fkey'
  ) then
    alter table public.friendships
      add constraint friendships_requester_player_id_fkey
      foreign key (requester_player_id) references public.profiles (player_id)
      on delete cascade
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'friendships'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'friendships_addressee_player_id_fkey'
  ) then
    alter table public.friendships
      add constraint friendships_addressee_player_id_fkey
      foreign key (addressee_player_id) references public.profiles (player_id)
      on delete cascade
      not valid;
  end if;
end
$$;

-- Supporting index for the achievements FK. friendships already has
-- friendships_requester_idx and friendships_addressee_idx from 0003; without
-- an index on the referencing column, every profile delete forces a
-- sequential scan of the child table.
create index if not exists player_achievements_player_id_idx
  on public.player_achievements (player_id);

-- ---------------------------------------------------------------------------
-- 3. Optional: clean up orphans and fully validate (review before running)
-- ---------------------------------------------------------------------------
-- Left commented out on purpose — it deletes rows. Run step 1's counts first,
-- inspect anything non-zero with the SELECTs below, and only then uncomment.
-- Until validated the constraints are still enforced for all new writes and
-- still cascade; validating only closes the historical gap.
--
-- -- Inspect first:
-- select * from public.player_achievements a
--   where not exists (select 1 from public.profiles p where p.player_id = a.player_id);
-- select * from public.friendships f
--   where not exists (select 1 from public.profiles p where p.player_id = f.requester_player_id)
--      or not exists (select 1 from public.profiles p where p.player_id = f.addressee_player_id);
--
-- -- Then delete and validate:
-- delete from public.player_achievements a
--   where not exists (select 1 from public.profiles p where p.player_id = a.player_id);
-- delete from public.friendships f
--   where not exists (select 1 from public.profiles p where p.player_id = f.requester_player_id)
--      or not exists (select 1 from public.profiles p where p.player_id = f.addressee_player_id);
--
-- alter table public.player_achievements validate constraint player_achievements_player_id_fkey;
-- alter table public.friendships validate constraint friendships_requester_player_id_fkey;
-- alter table public.friendships validate constraint friendships_addressee_player_id_fkey;
