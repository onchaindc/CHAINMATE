#!/bin/sh
# Sanity check: every `create policy` in the bundle must have a matching
# `drop policy if exists` guard, otherwise a second RUN_ALL paste dies with 42710.
file="supabase/RUN_ALL.sql"
grep 'create policy' "$file" | sed 's/create policy "//;s/".*//' | sort > /tmp/cm_creates.txt
grep 'drop policy if exists' "$file" | sed 's/.*drop policy if exists "//;s/".*//' | sort > /tmp/cm_drops.txt
printf 'create policies: %s\n' "$(grep -c . /tmp/cm_creates.txt)"
printf 'drop guards:     %s\n' "$(grep -c . /tmp/cm_drops.txt)"
echo '--- policies missing a guard:'
comm -23 /tmp/cm_creates.txt /tmp/cm_drops.txt
echo '--- (end)'
