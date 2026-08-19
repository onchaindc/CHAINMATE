-- ChainMate — allow guest profiles (user_id nullable)
-- ===================================================
-- Run once in Supabase (Dashboard → SQL Editor → New query, paste, Run).
-- Idempotent: safe to run again.
--
-- Why this exists
-- ---------------
-- 0001_init.sql declares:
--
--   user_id uuid primary key references auth.users (id) on delete cascade
--
-- while its own header comment states "guests keep user_id NULL until they
-- create an account". Both cannot hold — a PRIMARY KEY is implicitly NOT NULL.
-- The comment describes the intent the application code was written against,
-- so the constraint is what's wrong.
--
-- Consequence: upsertProfiles() in lib/supabase/db.ts writes guest rows with
-- player_id/username/rating and no user_id, so every guest profile insert
-- fails with a not-null violation. Guests never get a durable profile row.
--
-- Fix: promote player_id (already `not null unique`) to primary key, and let
-- user_id be a nullable unique column that still references auth.users. This
-- keeps profileForUserId() returning at most one row, and keeps account
-- deletion cascading from auth.users.

-- ---------------------------------------------------------------------------
-- 1. player_id becomes the primary key
-- ---------------------------------------------------------------------------
do $$
begin
  -- Only act if user_id is still the PK, so re-running is a no-op.
  if exists (
    select 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.table_name = 'profiles'
      and tc.constraint_type = 'PRIMARY KEY'
      and kcu.column_name = 'user_id'
  ) then
    -- Guard: player_id must be complete and unique before it can be the PK.
    if exists (select 1 from public.profiles where player_id is null) then
      raise exception 'Cannot repoint primary key: public.profiles has NULL player_id rows';
    end if;

    alter table public.profiles drop constraint profiles_pkey;
    alter table public.profiles add constraint profiles_pkey primary key (player_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. user_id becomes nullable
-- ---------------------------------------------------------------------------
-- Dropping the PK above does not clear the NOT NULL that the PK implied.
alter table public.profiles alter column user_id drop not null;

-- ---------------------------------------------------------------------------
-- 3. user_id stays unique (one profile per auth account)
-- ---------------------------------------------------------------------------
-- Postgres permits multiple NULLs in a unique index, so all guest rows coexist
-- while profileForUserId() -> .eq("user_id", …) still matches at most one row.
create unique index if not exists profiles_user_id_key
  on public.profiles (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Keep the auth.users FK (account deletion must still cascade)
-- ---------------------------------------------------------------------------
-- The original FK rode along with the inline `primary key references …` and
-- survives the PK swap, but assert it explicitly so a hand-patched database
-- converges to the same shape. DELETE /api/players/me relies on this cascade.
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'profiles'
      and constraint_type = 'FOREIGN KEY'
      and constraint_name = 'profiles_user_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end
$$;
