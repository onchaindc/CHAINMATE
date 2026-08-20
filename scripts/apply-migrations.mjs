#!/usr/bin/env node
/**
 * Apply the pending Supabase migrations, with a snapshot first.
 *
 *   node scripts/apply-migrations.mjs            # pre-flight, snapshot, migrate, verify
 *   node scripts/apply-migrations.mjs --dry-run  # pre-flight + snapshot only, no DDL
 *
 * Connection string comes from SUPABASE_DB_URL, read from the environment or
 * from .env.local. It never gets printed: the password is masked in all output.
 *
 * Everything here is safe to run twice. 0004 and 0005 are both idempotent, each
 * file runs inside its own transaction (so a failure rolls that file back
 * whole), and the only destructive statements in either migration are the
 * commented-out cleanup block at the end of 0005, which this script does not
 * touch.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = [
  "0004_profiles_nullable_user_id.sql",
  "0005_cascade_player_data.sql",
];
/** Tables 0004/0005 touch — the only ones worth snapshotting for this run. */
const SNAPSHOT_TABLES = ["profiles", "player_achievements", "friendships"];

const DRY_RUN = process.argv.includes("--dry-run");

/* ------------------------------------------------------------------ */
/* Connection string                                                   */
/* ------------------------------------------------------------------ */

function readEnvLocal() {
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    // Strip matching quotes; a URL with a '#' in the password must survive.
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

/** The URL with its password replaced by ***, safe to print. */
function maskUrl(url) {
  return url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]*(@)/, "$1***$2");
}

const env = { ...readEnvLocal(), ...process.env };
const dbUrl = env.SUPABASE_DB_URL || env.DATABASE_URL || "";

if (!dbUrl) {
  console.error(
    [
      "",
      "  SUPABASE_DB_URL is not set.",
      "",
      "  Supabase Dashboard -> Project Settings -> Database -> Connection string",
      "  -> URI. Copy it, substitute your database password, and add this line to",
      "  .env.local (gitignored):",
      "",
      "    SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres",
      "",
      "  Use the direct connection or the *session* pooler (port 5432). The",
      "  transaction pooler on 6543 does not run DDL reliably.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

const PREFLIGHT = `
select
  (select count(*)::int from public.profiles)                         as profile_rows,
  (select count(*)::int from public.profiles where user_id is null)   as guest_rows,
  (select count(*)::int from public.profiles where player_id is null) as blocks_0004,
  (select string_agg(kcu.column_name, ', ')
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name
      and tc.table_schema   = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.table_name   = 'profiles'
      and tc.constraint_type = 'PRIMARY KEY')                        as current_pk
`;

const VERIFY = `
select
  (select string_agg(kcu.column_name, ', ')
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name
      and tc.table_schema   = kcu.table_schema
    where tc.table_schema = 'public'
      and tc.table_name   = 'profiles'
      and tc.constraint_type = 'PRIMARY KEY')                         as pk,
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'user_id')                                    as user_id_nullable,
  (select count(*)::int from pg_indexes
    where schemaname = 'public' and indexname = 'profiles_user_id_key') as unique_idx,
  (select count(*)::int from information_schema.table_constraints
    where table_schema = 'public' and constraint_type = 'FOREIGN KEY'
      and constraint_name in (
        'player_achievements_player_id_fkey',
        'friendships_requester_player_id_fkey',
        'friendships_addressee_player_id_fkey'))                      as cascade_fks
`;

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

const client = new pg.Client({
  connectionString: dbUrl,
  // Supabase terminates TLS with its own CA chain; the connection is still
  // encrypted, we just don't pin the certificate.
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
  statement_timeout: 120_000,
});

/** RAISE NOTICE output — 0005 reports its orphan counts this way. */
const notices = [];
client.on("notice", (n) => {
  if (n?.message) notices.push(n.message);
});

function heading(text) {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

let exitCode = 0;

try {
  console.log(`\nConnecting to ${maskUrl(dbUrl)}`);
  await client.connect();
  console.log("Connected.");

  /* 1. Pre-flight ---------------------------------------------------- */
  heading("1. Pre-flight");
  const pre = (await client.query(PREFLIGHT)).rows[0];
  console.table(pre);

  if (pre.blocks_0004 > 0) {
    console.error(
      `\nStopping: public.profiles has ${pre.blocks_0004} row(s) with a NULL player_id.\n` +
        "0004 refuses to repoint the primary key while those exist. Inspect them with:\n" +
        "  select * from public.profiles where player_id is null;",
    );
    process.exit(2);
  }
  console.log(
    pre.current_pk === "player_id"
      ? "0004 has already been applied (primary key is player_id)."
      : `Primary key is currently "${pre.current_pk}" — 0004 is pending.`,
  );

  /* 2. Snapshot ------------------------------------------------------ */
  heading("2. Snapshot");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, ".data", "backups", `pre-0004-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  for (const table of SNAPSHOT_TABLES) {
    try {
      const { rows } = await client.query(`select * from public.${table}`);
      const file = join(outDir, `${table}.json`);
      writeFileSync(file, JSON.stringify(rows, null, 2), "utf8");
      console.log(`  ${table}: ${rows.length} row(s) -> ${file}`);
    } catch (err) {
      console.log(`  ${table}: skipped (${err.message})`);
    }
  }
  console.log(
    "\nNote: these migrations do not delete data. 0004 swaps a primary key and\n" +
      "drops a NOT NULL; 0005 adds NOT VALID foreign keys and prints orphan counts.\n" +
      "The snapshot is a precaution, not a rescue plan.",
  );

  if (DRY_RUN) {
    console.log("\n--dry-run: stopping before any DDL.");
    process.exit(0);
  }

  /* 3. Migrate ------------------------------------------------------- */
  heading("3. Migrations");
  for (const name of MIGRATIONS) {
    const sql = readFileSync(join(ROOT, "supabase", "migrations", name), "utf8");
    notices.length = 0;
    process.stdout.write(`  ${name} ... `);
    try {
      // One transaction per file: a failure rolls that migration back whole
      // rather than leaving the schema half-changed.
      await client.query("begin");
      await client.query(sql);
      await client.query("commit");
      console.log("applied");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.log("FAILED (rolled back)");
      throw err;
    }
    for (const n of notices) console.log(`      NOTICE: ${n}`);
  }

  /* 4. Verify -------------------------------------------------------- */
  heading("4. Verify");
  const post = (await client.query(VERIFY)).rows[0];
  console.table(post);

  const checks = [
    ["primary key is player_id", post.pk === "player_id"],
    ["user_id is nullable", post.user_id_nullable === "YES"],
    ["partial unique index on user_id", post.unique_idx === 1],
    ["3 cascading foreign keys", post.cascade_fks === 3],
  ];
  console.log();
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  if (checks.every(([, ok]) => ok)) {
    console.log("\nBoth migrations are in place. Guest profile rows can now be written.");
  } else {
    console.log("\nSomething did not land — see the FAIL lines above.");
    exitCode = 3;
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  if (err.hint) console.error(`Hint: ${err.hint}`);
  exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

process.exit(exitCode);
