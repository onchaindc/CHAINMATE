-- ChainMate — profile pictures (avatars)
-- ================================================
-- Idempotent, additive.
--
--   1. profiles.avatar_url — the public URL of the player's picture
--   2. the public `avatars` storage bucket the upload route writes to
--
-- No RLS policies are needed for the app: every upload goes through the
-- server route with the service-role key, and reads use the bucket's public
-- URL. The bucket must be PUBLIC so <img> tags can load the pictures.

alter table public.profiles
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;
