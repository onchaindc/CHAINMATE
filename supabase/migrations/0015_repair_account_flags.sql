-- ChainMate — repair account rows guest-marked by the old stats-mirror bug
-- ============================================================
-- Idempotent. Companion to 0014: that heal only repairs rows that still
-- carry their auth user id (user_id NOT NULL). Rows inserted by the OLD
-- stats mirror before an account linked carry the account's `acct_…` id
-- but a NULL user_id and is_guest: true — 0014's predicate never matched
-- them, so the admin's registered count stayed at zero even after running
-- it.
--
-- The predicate is definitional: `acct_…` player ids are minted ONLY by the
-- account-creation flow (app/api/identity/link). Guest ids are `0x…`
-- device ids and never collide with the prefix. Re-running updates zero
-- rows.

update public.profiles
set is_guest = false
where player_id like 'acct_%'
  and is_guest is true;
