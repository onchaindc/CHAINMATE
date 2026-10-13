/**
 * The cross-instance status lock — and its self-heal.
 *
 * transitionTournamentStatus is the durable lock behind every lifecycle
 * transition (start, complete, cancel). A guarded UPDATE that matches zero
 * rows has two meanings: another instance genuinely won the race, OR the
 * mirror row is missing/stale because the best-effort mirror write failed at
 * some earlier point. Before the heal, meaning (b) was PERMANENT: every host
 * action afterward died with "could not be started — try again" and nothing
 * ever healed it (the fast store stayed correct; only the mirror was wrong).
 *
 * The heal: when the fast store still holds `from`, nobody transitioned
 * anywhere — rewrite the mirror row from the fast document and retry the
 * guarded update once. These tests drive the REAL engine over the REAL file
 * store with only the durable-lock client faked (there is no environment
 * that points the app at a test database).
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as EngineModule from "@/lib/server/tournaments";
import type * as StoreModule from "@/lib/server/tournament-store";
import type { TournamentStatusLockAdmin } from "@/lib/server/tournament-store";
import type { TournamentDocument } from "@/lib/server/tournament-store";
import type { CreateTournamentInput } from "@/lib/server/tournaments";

let engine: typeof EngineModule;
let store: typeof StoreModule;

let DATA_ROOT: string;
const HOST = "acct_lock_host";
let seq = 0;

/**
 * In-memory mirror table recording every status the lock's UPDATE endorses,
 * plus one pinned "outside-world" state. Behaves like PostgREST: the UPDATE
 * returns rows only when a row exists AND its status still matches the
 * guard; the read answers only when a row exists.
 */
function makeMirrorAdmin(): {
  admin: TournamentStatusLockAdmin;
  rows: Map<string, { status: string }>;
} {
  const rows = new Map<string, { status: string }>();
  const admin = {
    from(_table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq(_c1: string, id: string) {
              return {
                eq(_c2: string, from: string) {
                  return {
                    select: async () => {
                      const row = rows.get(id);
                      if (!row || row.status !== from) return { data: null, error: null };
                      row.status = String(values.status);
                      return { data: [{ id }], error: null };
                    },
                  };
                },
              };
            },
          };
        },
        select(_columns: string) {
          return {
            eq(_c: string, id: string) {
              return {
                maybeSingle: async () => {
                  const row = rows.get(id);
                  return { data: row ? { status: row.status } : null, error: null };
                },
              };
            },
          };
        },
        upsert: async (row: Record<string, unknown>) => {
          rows.set(String(row.id), { ...row, status: String(row.status) } as { status: string });
          return { error: null };
        },
      };
    },
  } as unknown as TournamentStatusLockAdmin;
  return { admin, rows };
}

async function engineDoc(id: string): Promise<TournamentDocument> {
  const doc = await store.getTournamentDoc(id);
  assert.ok(doc, "tournament document must exist");
  return doc;
}

async function readyRegistrations(over: Partial<CreateTournamentInput> = {}): Promise<string> {
  seq += 1;
  const doc = await engine.createTournament(HOST, {
    name: `Status lock ${seq}`,
    format: "swiss",
    timeControl: "5 + 0",
    maxPlayers: 8,
    ...over,
  });
  const opened = await engine.transitionTournament(doc.id, HOST, "registration");
  assert.ok(opened.ok, opened.ok ? "" : opened.error);
  for (const p of ["acct_lock_a", "acct_lock_b"]) {
    const res = await engine.joinTournament(doc.id, p);
    assert.ok(res.ok, res.ok ? "" : res.error);
  }
  return doc.id;
}

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-status-lock-"));
  process.chdir(DATA_ROOT);
  for (const k of [
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NIMIQ_RPC_URL",
  ]) {
    delete process.env[k];
  }
  process.env.TOURNAMENT_ROUND_INTERMISSION_MS = "0";

  engine = await import("@/lib/server/tournaments");
  store = await import("@/lib/server/tournament-store");

  engine.setTournamentCreationGateDeps({
    getLinkedWallet: async (playerId: string) => ({
      address: `NQ${Buffer.from(playerId).toString("hex").slice(0, 34).padEnd(34, "7")}`,
      network: "test",
    }),
    getAccountBalanceLuna: async () => BigInt(1000) * BigInt(100_000),
    isGuestAccount: async () => false,
  });

  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

test("start with a MISSING mirror row: the lock heals and the tournament starts", async () => {
  const id = await readyRegistrations();
  const { admin, rows } = makeMirrorAdmin();
  store.setTournamentStatusLockAdmin(admin);

  try {
    // No row exists at all (the mirror write never landed — the exact state
    // a lost mirror write strands the event in). The heal must insert it.
    const res = await engine.transitionTournament(id, HOST, "in_progress");
    assert.ok(res.ok, `start refused with no mirror row: ${res.ok ? "" : res.error}`);

    const doc = await engineDoc(id);
    assert.equal(doc.status, "in_progress", "the event actually started");
    assert.equal(doc.currentRound, 1, "round 1 was generated");
    assert.ok(
      doc.matches.some((m) => m.round === 1 && m.gameId),
      "the round-1 fixture exists",
    );
    assert.equal(rows.get(id)?.status, "in_progress", "the mirror row now tracks the event");
  } finally {
    store.setTournamentStatusLockAdmin(null);
  }
});

test("start with a STALE mirror row: healed, not refused forever", async () => {
  const id = await readyRegistrations();
  const { admin, rows } = makeMirrorAdmin();
  // A previous transition's mirror write failed, stranding the row on an
  // old status. The guarded UPDATE can never match this until it heals.
  rows.set(id, { status: "draft" });
  store.setTournamentStatusLockAdmin(admin);

  try {
    const res = await engine.transitionTournament(id, HOST, "in_progress");
    assert.ok(res.ok, `start refused with a stale mirror row: ${res.ok ? "" : res.error}`);
    const doc = await engineDoc(id);
    assert.equal(doc.status, "in_progress");
    assert.ok(doc.matches.some((m) => m.gameId));
  } finally {
    store.setTournamentStatusLockAdmin(null);
  }
});

test("a mirror already at the TARGET status is adopted, not fought", async () => {
  const id = await readyRegistrations();
  const { admin, rows } = makeMirrorAdmin();
  rows.set(id, { status: "in_progress" }); // locked elsewhere / half-started wedge
  store.setTournamentStatusLockAdmin(admin);

  try {
    const res = await engine.transitionTournament(id, HOST, "in_progress");
    assert.ok(res.ok, `host start after a wedge: ${res.ok ? "" : res.error}`);
    const doc = await engineDoc(id);
    assert.equal(doc.status, "in_progress");
    assert.equal(rows.get(id)?.status, "in_progress");
  } finally {
    store.setTournamentStatusLockAdmin(null);
  }
});

test("a genuine cross-instance race is still respected: no heal when the fast doc moved", async () => {
  const id = await readyRegistrations();
  const { admin, rows } = makeMirrorAdmin();
  // The mirror row is stranded on a stale status (`locked` — the previous
  // transition's mirror write failed), and the fast store has already moved
  // on (another instance completed the start): simulate by advancing the
  // durable document underneath the caller.
  rows.set(id, { status: "locked" });
  store.setTournamentStatusLockAdmin(admin);

  try {
    const biased = await engineDoc(id);
    biased.status = "in_progress";
    await store.writeTournamentDoc(biased);

    // The lock must NOT rewrite the mirror: the document already moved, so
    // whatever happened is the other instance's game. Zero-row refusal stands.
    const won = await store.transitionTournamentStatus(id, "registration", "in_progress");
    assert.equal(won, false, "no heal when the fast document no longer agrees");
    assert.equal(rows.get(id)?.status, "locked", "the mirror row is untouched");
  } finally {
    store.setTournamentStatusLockAdmin(null);
  }
});
