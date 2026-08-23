#!/usr/bin/env node
/**
 * Read-only: dump the snapshots of the games that matter to the two reported
 * bugs, so the failure is read off real state instead of guessed at.
 * SELECT only.
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
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = { ...readEnvLocal(), ...process.env };
const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL || env.DATABASE_URL || "",
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

const ms = (n) => (n == null ? "—" : new Date(Number(n)).toISOString());

try {
  await client.connect();

  const { rows } = await client.query(`
    select id, white_player_id, black_player_id, status, result, winner_player_id,
           created_at, started_at, ended_at, summary, snapshot
      from public.games
     order by created_at desc
     limit 6`);

  for (const r of rows) {
    const snap = typeof r.snapshot === "string" ? JSON.parse(r.snapshot) : r.snapshot;
    console.log(`\n${"=".repeat(72)}`);
    console.log(`${r.id}   [${r.status} / ${r.result}]`);
    console.log(`${"=".repeat(72)}`);
    console.log(`  white .......... ${r.white_player_id}`);
    console.log(`  black .......... ${r.black_player_id || "(empty)"}`);
    console.log(`  created ........ ${ms(r.created_at)}`);
    console.log(`  started ........ ${ms(r.started_at)}`);
    console.log(`  ended .......... ${ms(r.ended_at)}`);
    console.log(`  lifetime ....... ${r.ended_at && r.created_at ? `${(Number(r.ended_at) - Number(r.created_at)) / 1000}s` : "—"}`);
    console.log(`  db summary ..... ${JSON.stringify(r.summary)}`);
    if (!snap) {
      console.log("  snapshot ....... (none)");
      continue;
    }
    console.log(`  snap.status .... ${snap.status}`);
    console.log(`  snap.creator ... ${snap.creator}`);
    console.log(`  snap.opponent .. ${JSON.stringify(snap.opponent)}`);
    console.log(`  snap.invited ... ${JSON.stringify(snap.invited)}`);
    console.log(`  snap.visibility  ${snap.visibility}`);
    console.log(`  snap.startedAt . ${ms(snap.startedAt)}`);
    console.log(`  snap.updatedAt . ${ms(snap.updatedAt)}`);
    console.log(`  snap.endedAt ... ${ms(snap.endedAt)}`);
    console.log(`  moves .......... ${Array.isArray(snap.moves) ? snap.moves.length : "?"}`);
    if (Array.isArray(snap.moves) && snap.moves.length) {
      console.log(
        `  move list ...... ${snap.moves
          .map((m) => (typeof m === "string" ? m : m.san ?? m.notation ?? JSON.stringify(m)))
          .join(" ")}`,
      );
      const times = snap.moves.map((m) => m?.at).filter(Boolean);
      if (times.length) console.log(`  first/last move  ${ms(times[0])} → ${ms(times[times.length - 1])}`);
    }
    console.log(`  snap.summary ... ${JSON.stringify(snap.summary)?.slice(0, 160)}`);
    console.log(`  snap.analysis .. ${snap.analysis ? `${JSON.stringify(snap.analysis).slice(0, 120)}…` : "(none)"}`);
    console.log(`  clocks ......... ${JSON.stringify(snap.clocks ?? snap.clock ?? null)}`);
    console.log(`  other keys ..... ${Object.keys(snap).join(", ")}`);
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
