/**
 * Live-fire harness (phase 1): create + fill + start a real Swiss tournament
 * against the REAL engine and the REAL .data file store, so the running dev
 * server can then drive the games through the public HTTP API.
 *
 * The wallet-creation gate uses its documented test seam
 * (setTournamentCreationGateDeps) — the same one the engine test suite uses —
 * because a HTTP client can never bypass a server-authoritative gate, and the
 * harness must not fake anything the real players cannot fake.
 *
 * Run from the project root: node --import ./tests/node/register.mjs scripts/livefire-tournament.mts
 */
import { mkdirSync } from "node:fs";

// Preview-side storage — the directory the dev server's file store uses.
mkdirSync(".data", { recursive: true });

process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const HOST = "0xac73d804b061f0c38e073ed651ed4c5077a36273"; // the operator account
const GUESTS = [
  "0xlivefire_a_00000000000000000000000000001",
  "0xlivefire_b_00000000000000000000000000002",
  "0xlivefire_c_00000000000000000000000000003",
  "0xlivefire_d_00000000000000000000000000004",
];

const NIMIQ_NETWORK = (await import("@/lib/nimiq/config")).NIMIQ_NETWORK;

const engine = await import("@/lib/server/tournaments");

// The documented seam: the hosting gate's wallet reads, faked exactly like the
// engine suite does — including the REAL network name this deployment runs
// on, which the gate validates against. Everything else is the real engine
// on the real store.
engine.setTournamentCreationGateDeps({
  getLinkedWallet: async () => ({ address: "NQ LIVEFIRE TREASURY 0000", network: NIMIQ_NETWORK }),
  getAccountBalanceLuna: async () => BigInt(1000) * BigInt(100_000),
});

const doc = await engine.createTournament(HOST, {
  name: "Live-fire Swiss I",
  description: "Engine validation event — engine-driven, real lifecycle",
  format: "swiss",
  timeControl: "10 + 0",
  maxPlayers: 8,
  swissRounds: 2,
});

// DRAFT → REGISTRATION (the host's "open registration" action), then fill.
const opened = await engine.transitionTournament(doc.id, HOST, "registration");
if (!opened.ok) throw new Error(`open-registration failed: ${opened.error}`);

for (const g of GUESTS) {
  const res = await engine.joinTournament(doc.id, g);
  if (!res.ok) throw new Error(`join failed for ${g}: ${res.error}`);
}
// Duplicate join must fail.
const dup = await engine.joinTournament(doc.id, GUESTS[0]!);
if (dup.ok) throw new Error("duplicate join was accepted — BUG");

const started = await engine.transitionTournament(doc.id, HOST, "in_progress");
if (!started.ok) throw new Error(`start failed: ${started.error}`);

const after = await engine.getTournamentDetail(doc.id, HOST);
console.log("TOURNAMENT_ID=" + doc.id);
console.log("detail keys=" + JSON.stringify(Object.keys(after ?? {})));
const t = (after as Record<string, unknown> | null) ?? {};
console.log(JSON.stringify(t, null, 1).slice(0, 3000));
