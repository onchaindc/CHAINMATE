/**
 * Live-fire harness (phase 2): drive tournament games through the REAL
 * public HTTP API of the running dev server — the exact endpoints the app's
 * own UI uses. No engine imports here: this proves the server-authoritative
 * path end to end (auth via resolveActingPlayer, move validation, result
 * ingestion, standings recomputation, round progression).
 *
 * Usage: node scripts/livefire-drives.mjs <tournamentId>
 */
const BASE = "http://localhost:3000";

const A = "0xlivefire_a_00000000000000000000000000001";
const B = "0xlivefire_b_00000000000000000000000000002";
const C = "0xlivefire_c_00000000000000000000000000003";
const D = "0xlivefire_d_00000000000000000000000000004";

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function get(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

const tid = process.argv[2];
if (!tid) throw new Error("usage: node scripts/livefire-drives.mjs <tournamentId>");
const detail = await get(`/api/tournaments/${tid}`);
const matches = detail.rounds.flatMap((r) => r.matches).filter((m) => m.status === "active");
console.log(`active matches in round 1: ${matches.length}`);

function sideOf(m, p) {
  if (m.whitePlayerId === p) return "white";
  if (m.blackPlayerId === p) return "black";
  return null;
}

async function move(gameId, playerId, from, to, promotion) {
  const { status, json } = await post(`/api/hosted/games/${gameId}`, {
    action: "move",
    playerId,
    move: { from, to, promotion },
  });
  if (status !== 200) throw new Error(`move ${from}-${to} by ${playerId}: ${status} ${JSON.stringify(json)}`);
  return json.game;
}

/* Game 1: A (white) vs B (black) — a real miniature, decided by resignation:
   1. d4 d5 2. Bf4 Nc6 3. e3 Nf6 4. Nf3 Bf5 5. Bd3 — then B resigns. */
const g1 = matches.find((m) => m.whitePlayerId === A);
if (!g1) throw new Error("no match with A as white");
console.log("game1:", g1.gameId);
await move(g1.gameId, A, "d2", "d4");
await move(g1.gameId, B, "d7", "d5");
await move(g1.gameId, A, "c1", "f4");
await move(g1.gameId, B, "b8", "c6");
await move(g1.gameId, A, "e2", "e3");
await move(g1.gameId, B, "g8", "f6");
await move(g1.gameId, A, "g1", "f3");
await move(g1.gameId, B, "c8", "f5");
console.log("  position set, B resigns…");
{
  const { status, json } = await post(`/api/hosted/games/${g1.gameId}`, { action: "resign", playerId: B });
  if (status !== 200) throw new Error("resign failed: " + JSON.stringify(json));
  console.log("  resigned. status:", json.game.status, "| winner:", json.game.winner);
}

/* Game 2: D (white) vs C (black) — a draw offer that C accepts after a few moves. */
const g2 = matches.find((m) => m.whitePlayerId === D);
if (!g2) throw new Error("no match with D as white");
console.log("game2:", g2.gameId);
await move(g2.gameId, D, "e2", "e4");
await move(g2.gameId, C, "e7", "e5");
await move(g2.gameId, D, "g1", "f3");
await move(g2.gameId, C, "b8", "c6");
{
  const off = await post(`/api/hosted/games/${g2.gameId}`, { action: "draw-offer", playerId: D });
  console.log("  draw offered:", off.status);
  const acc = await post(`/api/hosted/games/${g2.gameId}`, { action: "draw-respond", playerId: C, accept: true });
  if (acc.status !== 200) throw new Error("draw-respond failed: " + JSON.stringify(acc.json));
  console.log("  draw accepted. status:", acc.json.game.status, "| winner:", acc.json.game.winner);
}

/* Poll the tournament: standings + round 2 should appear. */
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const d = await get(`/api/tournaments/${tid}`);
  const all = d.rounds.flatMap((r) => r.matches);
  const r2 = all.filter((m) => m.round === 2);
  console.log(
    `poll ${i}: status=${d.summary.status} round=${d.summary.currentRound}/${d.summary.totalRounds} matches=${all.length} r2=${r2.length}`,
  );
  if (r2.length > 0) {
    for (const m of r2) console.log(`  r2: w=${m.whitePlayerId.slice(-2)} b=${m.blackPlayerId.slice(-2)} game=${m.gameId} ${m.status}`);
    console.log("standings after r1:");
    for (const s of d.standings) {
      console.log(`  #${s.rank} ${s.playerId.slice(-2)} pts=${s.points} ${s.wins}W/${s.losses}L/${s.draws}D`);
    }
    break;
  }
}
