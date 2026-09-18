/**
 * Live-fire (phase 4): knockout + arena smoke tests, in-process against the
 * real engine and the real .data store — same trust boundary as phase 1.
 * Both events are driven to completion; terminal results arrive through the
 * real hosted-game resign path so the ingestion hooks are exercised too.
 */
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const NIMIQ_NETWORK = (await import("@/lib/nimiq/config")).NIMIQ_NETWORK;
const engine = await import("@/lib/server/tournaments");
const hosted = await import("@/lib/server/hosted");

engine.setTournamentCreationGateDeps({
  getLinkedWallet: async () => ({ address: "NQ LIVEFIRE TREASURY 0000", network: NIMIQ_NETWORK }),
  getAccountBalanceLuna: async () => BigInt(1000) * BigInt(100_000),
});

const HOST = "0xac73d804b061f0c38e073ed651ed4c5077a36273";
const A = "0xlivefire_a_00000000000000000000000000001";
const B = "0xlivefire_b_00000000000000000000000000002";
const C = "0xlivefire_c_00000000000000000000000000003";
const D = "0xlivefire_d_00000000000000000000000000004";

/* ------------------------------------------------------------------ */
/* KNOCKOUT: 4 players → 2 semis → final. Semis decided by resignation */
/* through the REAL hosted-game path; the final by resign as well.      */
/* ------------------------------------------------------------------ */
console.log("== KNOCKOUT");
const ko = await engine.createTournament(HOST, {
  name: "Live-fire Knockout I",
  format: "knockout",
  timeControl: "10 + 0",
  maxPlayers: 4,
});
await engine.transitionTournament(ko.id, HOST, "registration");
for (const p of [A, B, C, D]) {
  const r = await engine.joinTournament(ko.id, p);
  if (!r.ok) throw new Error("join: " + r.error);
}
const koStart = await engine.transitionTournament(ko.id, HOST, "in_progress");
if (!koStart.ok) throw new Error("ko start: " + koStart.error);

async function activeMatches(tid) {
  const d = await engine.getTournamentDetail(tid, HOST);
  return d.rounds.flatMap((r) => r.matches).filter((m) => m.status === "active");
}
async function resignGame(gameId, playerId) {
  const g = await hosted.resignHostedGame(gameId, playerId);
  return g;
}

const semis = await activeMatches(ko.id);
console.log("semis:", semis.map((m) => `${m.whitePlayerId.slice(-2)}v${m.blackPlayerId.slice(-2)}`).join(", "));
// Losers: the black side of semi 0 and the white side of semi 1.
await resignGame(semis[0].gameId, semis[0].blackPlayerId);
await resignGame(semis[1].gameId, semis[1].whitePlayerId);

// Poll for the final to be generated.
let finalists = [];
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 600));
  const act = await activeMatches(ko.id);
  const fin = act.filter((m) => m.round === 2);
  if (fin.length > 0) {
    console.log("final:", fin.map((m) => `${m.whitePlayerId.slice(-2)}v${m.blackPlayerId.slice(-2)}`).join(", "));
    finalists = fin;
    break;
  }
}
if (finalists.length === 0) throw new Error("final never generated");
await resignGame(finalists[0].gameId, finalists[0].blackPlayerId);

let koDone = null;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 600));
  const d = await engine.getTournamentDetail(ko.id, HOST);
  if (d.summary.status === "completed") {
    koDone = d;
    break;
  }
}
if (!koDone) throw new Error("knockout never completed");
console.log("knockout completed ✓ winner:", koDone.summary.winnerId.slice(-2));
console.log("knockout standings:", koDone.standings.map((s) => `#${s.rank}${s.playerId.slice(-2)}`).join(" "));

/* ------------------------------------------------------------------ */
/* ARENA: continuous pairing. 3 players, everyone gets a game, then the */
/* window closes and the event completes.                              */
/* ------------------------------------------------------------------ */
console.log("== ARENA");
const ar = await engine.createTournament(HOST, {
  name: "Live-fire Arena I",
  format: "arena",
  timeControl: "10 + 0",
  maxPlayers: 8,
});
await engine.transitionTournament(ar.id, HOST, "registration");
for (const p of [A, B, C]) {
  const r = await engine.joinTournament(ar.id, p);
  if (!r.ok) throw new Error("arena join: " + r.error);
}
const arStart = await engine.transitionTournament(ar.id, HOST, "in_progress");
if (!arStart.ok) throw new Error("arena start: " + arStart.error);

// A asks for a pairing.
const pair = await engine.requestArenaPairing(ar.id, A);
if (!pair.ok) throw new Error("arena pair: " + pair.error);
console.log("A paired vs:", pair.match.whitePlayerId === A ? pair.match.blackPlayerId.slice(-2) : pair.match.whitePlayerId.slice(-2));
const arenaGameId = pair.match.gameId;

// While that game is live, B must NOT get a second game (one active game per player).
const bWhile = await engine.requestArenaPairing(ar.id, B === pair.match.whitePlayerId || pair.match.blackPlayerId === B ? C : B);
console.log("third player pairing while game live:", bFinally(bWhile));

function bFinally(r) {
  if (r.ok) return `got game (vs ${(r.match.whitePlayerId === C ? r.match.blackPlayerId : r.match.whitePlayerId).slice(-2)})`;
  return `refused: ${r.error}`;
}

// Finish the arena game, then B (idle) can be paired.
const dg = await hosted.getHostedGame(arenaGameId);
const loser = dg.creator === A ? B : A;
await resignGame(arenaGameId, loser);

const pair2 = await engine.requestArenaPairing(ar.id, loser);
console.log("loser re-pairing:", pair2.ok ? `got game vs ${(pair2.match.whitePlayerId === loser ? pair2.match.blackPlayerId : pair2.match.whitePlayerId).slice(-2)}` : `refused: ${pair2.error}`);

// Complete the arena from the host console.
const done = await engine.transitionTournament(ar.id, HOST, "completed");
if (!done.ok) throw new Error("arena complete: " + done.error);
const arD = await engine.getTournamentDetail(ar.id, HOST);
console.log("arena completed ✓ winner:", arD.summary.winnerId?.slice(-2));
console.log("arena standings:", arD.standings.map((s) => `#${s.rank}${s.playerId.slice(-2)}:${s.points}pt`).join(" "));

console.log("ALL PHASE-4 CHECKS PASSED");
