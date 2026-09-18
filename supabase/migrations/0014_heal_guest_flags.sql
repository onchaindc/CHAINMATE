-- ChainMate — heal accounts demoted to guests by the old stats-mirror bug
-- ============================================================
-- Idempotent. The stats mirror once wrote is_guest: true over real account
-- rows (fixed in code, but the flipped rows stayed flipped), which drained
-- the admin's registered-user count and the account list toward zero.
--
-- The predicate is exact: a profile bound to a Supabase auth user
-- (user_id NOT NULL) is by definition a registered account. Guest rows
-- always carry user_id NULL (migration 0004), so this can never promote a
-- guest. Re-running updates zero rows.

update public.profiles
set is_guest = false
where user_id is not null
  and is_guest is true;
