#!/usr/bin/env node
/**
 * Read-only diagnostic for the two reported bugs:
 *   (b) a finished game does not appear in the player's history
 *   (c) live search never pairs two players
 *
 * Both would be explained if the server is not actually writing to Supabase,
 * so this asks the database directly. SELECT only — no writes, no DDL.
 * The connection string is never printed.
 *
 *   node scripts/diagnose-db.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvLocal() {
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const env = { ...readEnvLocal(), ...process.env };
const dbUrl = env.SUPABASE_DB_URL || env.DATABASE_URL || "";
if (!dbUrl) {
  console.error("SUPABASE_DB_URL is not set (see scripts/apply-migrations.mjs).");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
  statement_timeout: 60_000,
});

function heading(text) {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

const ms = (n) => (n == null ? "—" : new Date(Number(n)).toISOString());

try {
  await client.connect();
  console.log("Connected (url not shown).");

  /* 1. Schema shape — is every migration actually applied? ------------- */
  heading("1. games columns");
  const cols = await client.query(`
    select column_name, data_type, is_nullable
      from information_schema.columns
     where table_schema = 'public' and table_name = 'games'
     order by ordinal_position`);
  console.table(cols.rows);

  /* 2. Row counts ------------------------------------------------------ */
  heading("2. counts");
  const counts = await client.query(`
    select
      (select count(*)::int from public.games)                                as games_total,
      (select count(*)::int from public.games where id like 'hosted_s%')      as pool_rows,
      (select count(*)::int from public.games where snapshot is null)         as games_without_snapshot,
      (select count(*)::int from public.profiles)                             as profiles_total,
      (select count(*)::int from public.profiles where is_guest = false)      as account_profiles,
      (select count(*)::int from public.profiles where games > 0)             as profiles_with_games`);
  console.table(counts.rows[0]);

  /* 3. Status breakdown ------------------------------------------------ */
  heading("3. games by status");
  const byStatus = await client.query(`
    select status,
           count(*)::int                                     as n,
           count(*) filter (where id like 'hosted_s%')::int   as pool_rows
      from public.games
     group by status
     order by n desc`);
  console.table(byStatus.rows);

  /* 4. The 15 most recent games ---------------------------------------- */
  heading("4. 15 most recent games (newest first)");
  const recent = await client.query(`
    select id, white_player_id, black_player_id, status, result,
           winner_player_id, time_control, created_at, ended_at,
           (snapshot is not null) as has_snapshot,
           jsonb_array_length(
             case when jsonb_typeof(moves) = 'array' then moves else '[]'::jsonb end
           ) as move_rows
      from public.games
     order by created_at desc
     limit 15`);
  console.table(
    recent.rows.map((r) => ({
      id: r.id,
      white: r.white_player_id,
      black: r.black_player_id || "(empty)",
      status: r.status,
      result: r.result,
      tc: r.time_control,
      created: ms(r.created_at),
      ended: ms(r.ended_at),
      snap: r.has_snapshot,
    })),
  );

  /* 5. The 15 most recent profiles ------------------------------------- */
  heading("5. 15 most recent profiles");
  const profiles = await client.query(`
    select player_id, username, is_guest, rating, rd, games, wins, losses, draws,
           last_played_at, created_at
      from public.profiles
     order by created_at desc
     limit 15`);
  console.table(
    profiles.rows.map((r) => ({
      player_id: r.player_id,
      username: r.username,
      guest: r.is_guest,
      rating: r.rating,
      rd: r.rd,
      games: r.games,
      "w/l/d": `${r.wins}/${r.losses}/${r.draws}`,
      last_played: ms(r.last_played_at),
      created: r.created_at?.toISOString?.() ?? String(r.created_at),
    })),
  );

  /* 6. Do recent games' players have profile rows? --------------------- */
  heading("6. recent game participants vs profiles");
  const orphans = await client.query(`
    with players as (
      select white_player_id as pid from public.games
       where id not like 'hosted_s%'
      union
      select black_player_id from public.games
       where id not like 'hosted_s%' and black_player_id <> ''
    )
    select p.pid,
           (pr.player_id is not null) as has_profile,
           pr.username, pr.games as profile_games
      from players p
      left join public.profiles pr on pr.player_id = p.pid
     order by has_profile, p.pid
     limit 25`);
  console.table(orphans.rows);

  /* 7. Anything written in the last 48 hours? -------------------------- */
  heading("7. write recency");
  const recency = await client.query(`
    select
      (select max(created_at) from public.games)                        as newest_game_created_at,
      (select max(synced_at)  from public.games)                        as newest_game_synced_at,
      (select max(updated_at) from public.profiles)                     as newest_profile_update,
      (select count(*)::int from public.games
        where synced_at > now() - interval '48 hours')                  as games_written_48h,
      (select count(*)::int from public.profiles
        where updated_at > now() - interval '48 hours')                 as profiles_written_48h`);
  const rec = recency.rows[0];
  console.table({
    newest_game_created_at: ms(rec.newest_game_created_at),
    newest_game_synced_at: rec.newest_game_synced_at?.toISOString?.() ?? String(rec.newest_game_synced_at),
    newest_profile_update: rec.newest_profile_update?.toISOString?.() ?? String(rec.newest_profile_update),
    games_written_48h: rec.games_written_48h,
    profiles_written_48h: rec.profiles_written_48h,
    now: new Date().toISOString(),
  });
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
