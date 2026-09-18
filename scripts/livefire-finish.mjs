/**
 * Live-fire harness (phase 3): finish round 2 and verify the tournament
 * completes itself — final ranking, winner, engine-settled state.
 * Usage: node scripts/livefire-finish.mjs <tournamentId>
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
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function get(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

const tid = process.argv[2];
if (!tid) throw new Error("usage: node scripts/livefire-finish.mjs <tournamentId>");

async function move(gameId, playerId, from, to, promotion) {
  const { status, json } = await post(`/api/hosted/games/${gameId}`, {
    action: "move", playerId, move: { from, to, promotion },
  });
  if (status !== 200) throw new Error(`move ${from}-${to}: ${JSON.stringify(json)}`);
  return json.game;
}

const d0 = await get(`/api/tournaments/${tid}`);
const active = d0.rounds.flatMap((r) => r.matches).filter((m) => m.status === "active");
console.log("active round-2 matches:", active.length);

/* A vs C: scholar's mate — 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# */
const m1 = active.find((m) => m.whitePlayerId === A);
if (m1) {
  console.log("mate game:", m1.gameId);
  await move(m1.gameId, A, "e2", "e4");
  await move(m1.gameId, C, "e7", "e5");
  await move(m1.gameId, A, "d1", "h5");
  await move(m1.gameId, C, "b8", "c6");
  await move(m1.gameId, A, "f1", "c4");
  await move(m1.gameId, C, "g8", "f6");
  const g = await move(m1.gameId, A, "h5", "f7");
  console.log("  checkmate delivered. status:", g.status, "winner:", g.winner);
}

/* D vs B: short position, then D resigns (B takes the point). */
const m2 = active.find((m) => m.whitePlayerId === D);
if (m2) {
  console.log("resign game:", m2.gameId);
  await move(m2.gameId, D, "d2", "d4");
  await move(m2.gameId, B, "d7", "d5");
  await move(m2.gameId, D, "c2", "c4");
  await move(m2.gameId, B, "e7", "e6");
  const g = await post(`/api/hosted/games/${m2.gameId}`, { action: "resign", playerId: D });
  console.log("  resigned. status:", g.json.game.status, "winner:", g.json.game.winner);
}

/* Poll for engine completion. */
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const d = await get(`/api/tournaments/${tid}`);
  console.log(`poll ${i}: status=${d.summary.status} winner=${d.summary.winnerId ?? "—"}`);
  if (d.summary.status === "completed") {
    console.log("FINAL STANDINGS:");
    for (const s of d.standings) {
      console.log(`  #${s.rank} ${s.playerId.slice(-2)} pts=${s.points} ${s.wins}W/${s.losses}L/${s.draws}D`);
    }
    console.log("matches:", d.rounds.map((r) => `r${r.index}:${r.matches.filter((m) => m.status === "complete").length}/${r.matches.length}`).join(" "));
    console.log("ids: A=01 B=02 C=03 D=04");
    break;
  }
}
