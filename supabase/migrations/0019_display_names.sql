-- ChainMate — display names
-- =========================
-- Idempotent, additive. Adds an optional, free-form DISPLAY NAME to every
-- profile: a player-facing label shown on profile pages (emoji, spaces,
-- any characters welcome) that never replaces the username.
--
-- Separation of concerns, documented for future migrations:
--   * username  — the identity primitive: unique (case-insensitive index),
--     URL-addressable (/players/<username>), strictly validated, never
--     changed in meaning. Friend links, player search and the unique
--     index all keep using it exactly as before.
--   * display_name — the presentation layer: NOT unique, NOT indexed, NOT
--     url-safe, optional (NULL ≡ "no custom display name — show the
--     username"). Because it is purely presentational it never collides
--     and never needs uniqueness enforcement of any kind.
--
-- No default and no backfill: every existing profile keeps NULL and
-- displays exactly as before.

alter table public.profiles add column if not exists display_name text;

comment on column public.profiles.display_name is
  'Optional free-form display name (emoji and any characters allowed). Purely presentational: profiles without one display their username.';
