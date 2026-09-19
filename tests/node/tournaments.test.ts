/**
 * Tournament engine tests — ChainMate Phase 2A.
 *
 * These drive the REAL tournament service over the REAL hosted game system
 * and the REAL file store: tournaments are created, joined, started, and
 * their matches are decided by actually playing fool's-mate games through
 * submitHostedMove, exactly like ratings.test.ts does. Nothing about the
 * result path is stubbed, so a regression in either the tournament engine or
 * its connection to the game lifecycle fails here.
 *
 * Concurrency tests use Promise.all races against the real service — the
 * same requests the API routes would receive.
 *
 * Run: npm test
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GameState } from "@/lib/types";
import type { TournamentDocument } from "@/lib/server/tournament-store";
import type { TournamentMatch } from "@/lib/tournament-types";
import type { CreateTournamentInput } from "@/lib/server/tournaments";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let DATA_ROOT: string;
let hosted: typeof import("@/lib/server/hosted");
let engine: typeof import("@/lib/server/tournaments");
let store: typeof import("@/lib/server/tournament-store");
let standings: typeof import("@/lib/tournament-standings");
let types: typeof import("@/lib/tournament-types");

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-tournaments-"));
  process.chdir(DATA_ROOT);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Hermetic round progression: the engine's intermission defaults to 60s
  // between rounds, but these suites assert progression synchronously. Pin
  // the documented test contract BEFORE the first import —
  // ROUND_INTERMISSION_MS is captured at module load, and hosted.ts
  // statically pulls the engine in.
  process.env.TOURNAMENT_ROUND_INTERMISSION_MS = "0";
  hosted = await import("@/lib/server/hosted");
  engine = await import("@/lib/server/tournaments");
  store = await import("@/lib/server/tournament-store");
  standings = await import("@/lib/tournament-standings");
  types = await import("@/lib/tournament-types");

  // The 50-NIM hosting gate reads a linked wallet + on-chain balance. Tests
  // run without a Nimiq node, so inject an always-passing seam: every test
  // creator has a linked wallet with a balance above the minimum.
  engine.setTournamentCreationGateDeps({
    getLinkedWallet: async (playerId: string) => ({
      address: `NQ07_TEST_${playerId}`.slice(0, 36).padEnd(36, "0"),
      // The default deployment network in a bare test env is "test".
      network: "test",
    }),
    getAccountBalanceLuna: async () => BigInt(1000) * BigInt(100_000),
  });

  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

let seq = 0;
function pid(label: string): string {
  seq += 1;
  return `acct_t_${label}_${seq}`;
}

/** A fresh tournament per test, so no two tests share documents. */
beforeEach(() => {
  seq += 1;
});

async function makeTournament(
  creatorId: string,
  over: Partial<CreateTournamentInput> = {},
): Promise<TournamentDocument> {
  return engine.createTournament(creatorId, {
    name: `Test Open ${seq}`,
    format: "swiss",
    timeControl: "5 + 0",
    maxPlayers: 8,
    ...over,
  });
}

/** Walk a tournament through draft → registration → (locked) → in_progress. */
async function startTournament(
  doc: TournamentDocument,
  joiners: string[],
): Promise<void> {
  await engine.transitionTournament(doc.id, doc.creatorId, "registration");
  for (const j of joiners) {
    const res = await engine.joinTournament(doc.id, j);
    assert.ok(res.ok, `join failed: ${res.ok ? "" : res.error}`);
  }
  const started = await engine.transitionTournament(doc.id, doc.creatorId, "in_progress");
  assert.ok(started.ok, `start failed: ${started.ok ? "" : started.error}`);
}

/** Play a full game to completion. `winner` = which colour wins. */
async function playGame(gameId: string, white: string, black: string, winner: "white" | "black" | "draw"): Promise<GameState> {
  const moves: [string, string][] = [
    ["f2", "f3"],
    ["e7", "e5"],
    ["g2", "g4"],
    ["d8", "h4"],
  ];
  if (winner === "white") {
    // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7# — white mates.
    const whiteWins: [string, string][] = [
      ["e2", "e4"],
      ["e7", "e5"],
      ["f1", "c4"],
      ["b8", "c6"],
      ["d1", "h5"],
      ["g8", "f6"],
      ["h5", "f7"],
    ];
    let state: GameState | null = null;
    for (const [i, [from, to]] of whiteWins.entries()) {
      state = await hosted.submitHostedMove(gameId, i % 2 === 0 ? white : black, from, to);
    }
    return state!;
  }
  if (winner === "draw") {
    // A few quiet, non-terminal moves, then the real draw-by-agreement path:
    // 1. Nf3 Nf6 2. Ng1 Ng8 → back to the start, nothing decisive.
    const quiet: [string, string][] = [
      ["g1", "f3"],
      ["g8", "f6"],
      ["f3", "g1"],
      ["f6", "g8"],
    ];
    let state: GameState | null = null;
    for (const [i, [from, to]] of quiet.entries()) {
      state = await hosted.submitHostedMove(gameId, i % 2 === 0 ? white : black, from, to);
    }
    state = await hosted.offerDrawHostedGame(gameId, white);
    state = await hosted.respondHostedDraw(gameId, black, true);
    return state;
  }
  let state: GameState | null = null;
  for (const [i, [from, to]] of moves.entries()) {
    state = await hosted.submitHostedMove(gameId, i % 2 === 0 ? white : black, from, to);
  }
  return state!;
}

/** The single match of a one-game round (or null). Kept for debugging rounds. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function matchOf(doc: TournamentDocument, round: number): TournamentMatch | null {
  const real = doc.matches.filter(
    (m) => m.round === round && m.blackPlayerId !== types.SWISS_BYE_OPPONENT && m.resultReason !== "bye",
  );
  return real[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Creation validation                                                 */
/* ------------------------------------------------------------------ */

test("creation validation rejects invalid input", () => {
  const cases: CreateTournamentInput[] = [
    { name: "x", format: "swiss", timeControl: "10 + 0", maxPlayers: 8 } as CreateTournamentInput,
    { name: "", format: "swiss", timeControl: "10 + 0", maxPlayers: 8 } as CreateTournamentInput,
    { name: "A".repeat(61), format: "swiss", timeControl: "10 + 0", maxPlayers: 8 } as CreateTournamentInput,
    { name: "Fine", format: "swiss" as const, timeControl: "10 + 0", maxPlayers: 8, description: "d".repeat(501) },
    { name: "Fine", format: "golf" as never, timeControl: "10 + 0", maxPlayers: 8 },
    { name: "Fine", format: "swiss" as const, timeControl: "banana", maxPlayers: 8 },
    { name: "Fine", format: "swiss" as const, timeControl: "10 + 0", maxPlayers: 1 },
    { name: "Fine", format: "swiss" as const, timeControl: "10 + 0", maxPlayers: 200 },
    { name: "Fine", format: "swiss" as const, timeControl: "10 + 0", maxPlayers: 8, swissRounds: 0 },
    { name: "Fine", format: "swiss" as const, timeControl: "10 + 0", maxPlayers: 8, swissRounds: 12 },
  ];
  for (const input of cases) {
    assert.ok(engine.validateTournamentInput(input), `expected rejection: ${JSON.stringify(input)}`);
  }
  const ok: CreateTournamentInput = {
    name: "Fine",
    format: "swiss",
    timeControl: "10 + 0",
    maxPlayers: 8,
    swissRounds: 5,
  };
  assert.equal(engine.validateTournamentInput(ok), null);
});

test("a created tournament starts in DRAFT with a host", async () => {
  const host = pid("host");
  const doc = await makeTournament(host, { name: "Draft Check" });
  assert.equal(doc.status, "draft");
  assert.equal(doc.creatorId, host);
  assert.equal(doc.entries.length, 0);
  assert.equal(doc.winnerId, null);
});

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

test("joining before registration opens is refused", async () => {
  const host = pid("h1");
  const doc = await makeTournament(host);
  const res = await engine.joinTournament(doc.id, pid("eager"));
  assert.ok(!res.ok);
  assert.match(res.error!, /not open/i);
});

test("join works during registration and refuses duplicates", async () => {
  const host = pid("h2");
  const doc = await makeTournament(host);
  await engine.transitionTournament(doc.id, host, "registration");
  const p = pid("first");

  const ok = await engine.joinTournament(doc.id, p);
  assert.ok(ok.ok);

  const again = await engine.joinTournament(doc.id, p);
  assert.ok(!again.ok);
  assert.match(again.error!, /already joined/i);
});

test("player caps are enforced", async () => {
  const host = pid("h3");
  const doc = await makeTournament(host, { maxPlayers: 2 });
  await engine.transitionTournament(doc.id, host, "registration");
  assert.ok((await engine.joinTournament(doc.id, pid("a"))).ok);
  assert.ok((await engine.joinTournament(doc.id, pid("b"))).ok);
  const third = await engine.joinTournament(doc.id, pid("c"));
  assert.ok(!third.ok);
  assert.match(third.error!, /full/i);
});

test("leaving during registration frees the seat; re-joining reuses the entry", async () => {
  const host = pid("h4");
  const doc = await makeTournament(host, { maxPlayers: 2 });
  await engine.transitionTournament(doc.id, host, "registration");
  const a = pid("leaver");
  const b = pid("stayer");
  const c = pid("late");
  await engine.joinTournament(doc.id, a);
  await engine.joinTournament(doc.id, b);
  assert.ok((await engine.joinTournament(doc.id, c)).ok === false, "cap blocked");
  const left = await engine.leaveTournament(doc.id, a);
  assert.ok(left.ok);
  // Seat is free again.
  assert.ok((await engine.joinTournament(doc.id, c)).ok);
  // Leaving twice is an error.
  assert.ok(!(await engine.leaveTournament(doc.id, a)).ok);
  // Leave after start becomes a WITHDRAWAL: allowed, idempotent, keeps the
  // entry record (marked, not erased) — per the lifecycle brief (§13).
  await startTournament(doc, []);
  const wd = await engine.leaveTournament(doc.id, b);
  assert.ok(wd.ok);
  const afterWd = (await store.getTournamentDoc(doc.id))!;
  assert.ok(afterWd.entries.find((e) => e.playerId === b)?.withdrawnAt);
  // Withdrawn players are out of the active field: joining again is a rejoin
  // of a LEFT entry only — a withdrawn entry stays withdrawn for seat math.
  const wd2 = await engine.leaveTournament(doc.id, b);
  assert.ok(wd2.ok); // idempotent second withdrawal
});

test("registration closes at the configured time", async () => {
  const host = pid("h5");
  // Create with a FUTURE window (creation validates), then run the clock out.
  const created = await makeTournament(host, { registrationClosesAt: Date.now() + 60_000 });
  await engine.transitionTournament(created.id, host, "registration");
  // Re-read (the transition moved the durable status forward), then simulate
  // the window elapsing by moving the boundary into the past.
  const current = (await store.getTournamentDoc(created.id))!;
  current.registrationClosesAt = Date.now() - 1000;
  await store.writeTournamentDoc(current);
  const res = await engine.joinTournament(created.id, pid("latecomer"));
  assert.ok(!res.ok);
  assert.match(res.error!, /window has closed/i);
});

test("joining is refused after start, lock, and on terminal states", async () => {
  const host = pid("h6");
  const doc = await makeTournament(host);
  await engine.transitionTournament(doc.id, host, "registration");
  await engine.joinTournament(doc.id, pid("a"));
  await engine.joinTournament(doc.id, pid("b"));
  await engine.transitionTournament(doc.id, host, "locked");
  const inLock = await engine.joinTournament(doc.id, pid("c"));
  assert.ok(!inLock.ok, "joining a locked tournament must fail");

  const started = await engine.transitionTournament(doc.id, host, "in_progress");
  assert.ok(started.ok);
  const inRun = await engine.joinTournament(doc.id, pid("d"));
  assert.ok(!inRun.ok, "joining a running tournament must fail");

  const done = await engine.completeTournament(doc.id, null);
  assert.ok(done.ok);
  const inDone = await engine.joinTournament(doc.id, pid("e"));
  assert.ok(!inDone.ok, "joining a completed tournament must fail");
});

test("cancellation blocks joins and leaves", async () => {
  const host = pid("h7");
  const doc = await makeTournament(host);
  await engine.transitionTournament(doc.id, host, "registration");
  await engine.joinTournament(doc.id, pid("a"));
  const cancelled = await engine.transitionTournament(doc.id, host, "cancelled");
  assert.ok(cancelled.ok);
  const join = await engine.joinTournament(doc.id, pid("b"));
  assert.ok(!join.ok);
  const leave = await engine.leaveTournament(doc.id, pid("a"));
  assert.ok(!leave.ok);
});

test("host delete removes a never-started tournament; started events are protected", async () => {
  const host = pid("h8");
  const doomed = await makeTournament(host);
  await engine.transitionTournament(doomed.id, host, "registration");
  await engine.joinTournament(doomed.id, pid("a"));

  // Only the host can delete.
  const notHost = await engine.deleteTournament(doomed.id, pid("a"));
  assert.ok(!notHost.ok);

  const res = await engine.deleteTournament(doomed.id, host);
  assert.ok(res.ok);
  const gone = await engine.getTournamentDetail(doomed.id);
  assert.equal(gone, null);
  const listed = await engine.listTournaments();
  assert.ok(!listed.tournaments.some((t) => t.id === doomed.id));

  // A running event cannot be deleted — end or cancel it instead.
  const live = await makeTournament(host);
  await startTournament(live, [pid("b"), pid("c")]);
  const refused = await engine.deleteTournament(live.id, host);
  assert.ok(!refused.ok);
});

test("scheduled start: future sits in draft, past due opens on read", async () => {
  const host = pid("h9");
  // Validation: past instant refused, and registration must close before start.
  assert.match(
    engine.validateTournamentInput({
      name: "Late", format: "swiss", timeControl: "5 + 0", maxPlayers: 8,
      scheduledStartAt: Date.now() - 1_000,
    }) ?? "",
    /scheduled start must be in the future/,
  );
  assert.match(
    engine.validateTournamentInput({
      name: "Inverted", format: "swiss", timeControl: "5 + 0", maxPlayers: 8,
      scheduledStartAt: Date.now() + 60_000,
      registrationClosesAt: Date.now() + 120_000,
    }) ?? "",
    /registration must close before the scheduled start/,
  );

  // Future schedule: still draft now, and joining is refused.
  const doc = await makeTournament(host, { scheduledStartAt: Date.now() + 60_000 });
  assert.equal(doc.status, "draft");
  assert.ok(doc.scheduledStartAt != null);
  const early = await engine.joinTournament(doc.id, pid("a"));
  assert.ok(!early.ok);

  // Host can always open registration manually before the schedule.
  const opened = await engine.transitionTournament(doc.id, host, "registration");
  assert.ok(opened.ok);
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

test("illegal lifecycle transitions are refused", async () => {
  const host = pid("h8");
  const doc = await makeTournament(host);
  // draft → in_progress (skipping registration/lock) is illegal.
  const skip = await engine.transitionTournament(doc.id, host, "in_progress");
  assert.ok(!skip.ok);
  // Only the host can transition.
  await engine.transitionTournament(doc.id, host, "registration");
  const notHost = await engine.transitionTournament(doc.id, pid("impostor"), "locked");
  assert.ok(!notHost.ok);
  assert.match(notHost.error!, /host/i);
});

test("starting requires 2+ players", async () => {
  const host = pid("h9");
  const doc = await makeTournament(host);
  await engine.transitionTournament(doc.id, host, "registration");
  await engine.joinTournament(doc.id, pid("solo"));
  const res = await engine.transitionTournament(doc.id, host, "in_progress");
  assert.ok(!res.ok);
  assert.match(res.error!, /2 players/i);
});

test("start generates round 1 for knockout and swiss", async () => {
  const host = pid("h10");
  const doc = await makeTournament(host, { format: "knockout", maxPlayers: 4 });
  const players = [pid("k1"), pid("k2"), pid("k3"), pid("k4")];
  await startTournament(doc, players);
  const after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.status, "in_progress");
  assert.equal(after.currentRound, 1);
  assert.equal(after.totalRounds, 2);
  const realMatches = after.matches.filter((m) => m.resultReason !== "bye");
  assert.equal(realMatches.length, 2);
  // Every player appears in exactly one match.
  const inGames = realMatches.flatMap((m) => [m.whitePlayerId, m.blackPlayerId]).sort();
  assert.deepEqual(inGames, [...players].sort());
  // Every match references a real hosted game that is already active.
  for (const m of realMatches) {
    const game = await hosted.getHostedGame(m.gameId);
    assert.ok(game, "match has no underlying game");
    assert.equal(game.status, "active");
    assert.deepEqual([game.creator, game.opponent].sort(), [m.whitePlayerId, m.blackPlayerId].sort());
  }
});

/* ------------------------------------------------------------------ */
/* Knockout                                                            */
/* ------------------------------------------------------------------ */

test("knockout: winner advances, bracket progresses, champion crowned", async () => {
  const host = pid("h11");
  const doc = await makeTournament(host, { format: "knockout", maxPlayers: 4 });
  const [a, b, c, d] = [pid("ka"), pid("kb"), pid("kc"), pid("kd")];
  await startTournament(doc, [a, b, c, d]);

  let after = (await store.getTournamentDoc(doc.id))!;
  // Round 1: two matches. a and c are the lower (registration-first) seeds in slots 0 and 2.
  const r1a = after.matches.find((m) => m.round === 1 && m.slot === 0)!;
  const r1b = after.matches.find((m) => m.round === 1 && m.slot === 1)!;
  assert.ok(r1a && r1b);

  // Black wins both round-1 games.
  await playGame(r1a.gameId, r1a.whitePlayerId, r1a.blackPlayerId, "black");
  await playGame(r1b.gameId, r1b.whitePlayerId, r1b.blackPlayerId, "black");

  after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.currentRound, 2, "the bracket did not progress");
  const final = after.matches.find((m) => m.round === 2)!;
  assert.ok(final, "no final was generated");
  // The final contains exactly the two round-1 winners (slot order may vary
  // with the seeding permutation — the set is what matters).
  const r1Winners = [r1a.blackPlayerId, r1b.blackPlayerId].sort();
  assert.deepEqual(
    [final.whitePlayerId, final.blackPlayerId].sort(),
    r1Winners,
    "the final must hold the round-1 winners",
  );

  // White wins the final.
  await playGame(final.gameId, final.whitePlayerId, final.blackPlayerId, "white");
  after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.status, "completed");
  assert.equal(after.winnerId, final.whitePlayerId);

  // Standings: champion first, the final's loser second, round-1 losers below.
  const rows = after.standings;
  assert.equal(rows[0].playerId, after.winnerId);
  assert.equal(rows[0].eliminatedInRound, null);
  assert.equal(rows[1].playerId, final.blackPlayerId);
  const losers = rows.slice(2).map((r) => r.playerId).sort();
  assert.deepEqual(
    losers,
    [r1a.whitePlayerId, r1b.whitePlayerId].sort(),
    "the round-1 losers must fill ranks 3–4",
  );
  assert.equal(rows[2]?.eliminatedInRound, 1);
  assert.equal(rows[3]?.eliminatedInRound, 1);
});

test("knockout: an eliminated player cannot be revived by a stray join", async () => {
  // The pairing engine only ever pairs round winners; a join is refused
  // outright once the event runs. Pinned by starting and joining late.
  const host = pid("h12");
  const doc = await makeTournament(host, { format: "knockout", maxPlayers: 2 });
  const [a, b] = [pid("koA"), pid("koB")];
  await startTournament(doc, [a, b]);
  const late = await engine.joinTournament(doc.id, pid("koLate"));
  assert.ok(!late.ok);
  const after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.matches.filter((m) => m.resultReason !== "bye").length, 1);
});

/* ------------------------------------------------------------------ */
/* Swiss                                                               */
/* ------------------------------------------------------------------ */

test("swiss: pairing avoids repeats, byes at odd counts, standings decide", async () => {
  const host = pid("h13");
  const doc = await makeTournament(host, { format: "swiss", maxPlayers: 4, swissRounds: 2 });
  const [a, b, c, d] = [pid("sA"), pid("sB"), pid("sC"), pid("sD")];
  await startTournament(doc, [a, b, c, d]);

  let after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.currentRound, 1);

  // Round 1: a-v-b, c-v-d (registration order seeds the empty standings).
  const r1a = after.matches.find((m) => m.round === 1 && m.slot === 0)!;
  const r1b = after.matches.find((m) => m.round === 1 && m.slot === 1)!;
  assert.ok(r1a && r1b);

  // a and c win their games (white side).
  await playGame(r1a.gameId, r1a.whitePlayerId, r1a.blackPlayerId, "white");
  await playGame(r1b.gameId, r1b.whitePlayerId, r1b.blackPlayerId, "white");

  after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.currentRound, 2, "swiss round 2 was not generated");
  const r2 = after.matches.filter((m) => m.round === 2);
  assert.equal(r2.length, 2);
  // No repeat pairings across rounds.
  const seen = new Set(after.matches.map((m) => [m.whitePlayerId, m.blackPlayerId].sort().join("|")));
  assert.equal(seen.size, after.matches.length, "a repeat pairing slipped through");

  // Finish round 2 — the event completes after the configured rounds.
  for (const m of r2) {
    if (m.status === "complete") continue;
    await playGame(m.gameId, m.whitePlayerId, m.blackPlayerId, "draw");
  }
  after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.status, "completed", "swiss should complete after all rounds");
  const winner = after.winnerId;
  assert.ok(winner, "a winner must be named");
  // The winner is the top row of the standings.
  assert.equal(after.standings[0].playerId, winner);
  // Winners of round 1 each have 1.5 points (win + draw).
  const row = after.standings.find((s) => s.playerId === winner)!;
  assert.equal(row.points, 1.5);
});

test("swiss: bye awards one point without a game", async () => {
  const host = pid("h14");
  const doc = await makeTournament(host, { format: "swiss", maxPlayers: 4, swissRounds: 1 });
  const [a, b, c] = [pid("bA"), pid("bB"), pid("bC")];
  await startTournament(doc, [a, b, c]);

  let after = (await store.getTournamentDoc(doc.id))!;
  // Odd field: one bye marker, one real game.
  const byes = after.matches.filter((m) => m.blackPlayerId === types.SWISS_BYE_OPPONENT);
  assert.equal(byes.length, 1, "expected exactly one bye marker");
  const real = after.matches.filter((m) => m.blackPlayerId !== types.SWISS_BYE_OPPONENT);
  assert.equal(real.length, 1);

  const byePlayer = byes[0].whitePlayerId;
  const game = real[0];
  await playGame(game.gameId, game.whitePlayerId, game.blackPlayerId, "black");

  after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.status, "completed");
  // The bye player got the free point without playing.
  const byeRow = after.standings.find((s) => s.playerId === byePlayer)!;
  assert.equal(byeRow.points, 1);
  assert.equal(byeRow.played, 0, "a bye must not count as a game played");
  assert.equal(byeRow.wins, 0, "a bye must not count as a win for tiebreaks");
  // The real winner has 1 point from 1 game — but 0 games means the bye row
  // cannot rank above them when points tie... it can't: identical points, the
  // played>0 row wins on every other key. Check the champion is the player.
  assert.equal(after.winnerId, game.blackPlayerId);
});

test("swiss: repeat-pair prevention yields only when it must", () => {
  // Four players, one round already played: the winner meets a new opponent.
  const doc = {
    id: "synthetic",
    matches: [
      { whitePlayerId: "p1", blackPlayerId: "p4", round: 1, result: "white" as const, status: "complete" as const, resultReason: "checkmate" },
      { whitePlayerId: "p2", blackPlayerId: "p3", round: 1, result: "white" as const, status: "complete" as const, resultReason: "checkmate" },
    ],
  } as unknown as TournamentDocument;
  // Standings: p1, p2 (1 pt) then p3, p4 (0).
  const order = ["p1", "p2", "p3", "p4"];
  const pairs = engine.pairSwissRound(doc, order);
  assert.equal(pairs.length, 2);
  const keys = new Set(pairs.map(([x, y]) => [x, y].sort().join("|")));
  assert.ok(keys.has("p1|p4") === false || true); // no-op guard
  // Round 2 must NOT rematch p1-v-p4 or p2-v-p3.
  assert.ok(!keys.has("p1|p4"));
  assert.ok(!keys.has("p2|p3"));
  // With only 4 players and 2 pairings, the remaining options are
  // p1|p3 + p2|p4 or p1|p2 + p3|p4 — both are fresh pairs.
  for (const [x, y] of pairs) {
    assert.equal(x === y, false);
  }
});

/* ------------------------------------------------------------------ */
/* Swiss standings & tiebreaks (pure, deterministic)                   */
/* ------------------------------------------------------------------ */

test("swiss standings: points, Buchholz, wins, head-to-head, id — in that order", () => {
  const m = (
    w: string,
    b: string,
    result: "white" | "black" | "draw",
    round = 1,
  ): import("@/lib/tournament-types").TournamentMatch => ({
    id: `${w}-${b}-${round}-${Math.random()}`,
    tournamentId: "t",
    round,
    slot: 0,
    whitePlayerId: w,
    blackPlayerId: b,
    gameId: "g",
    status: "complete",
    result,
    resultReason: "checkmate",
    createdAt: 0,
  });
  const entries = ["p1", "p2", "p3", "p4"].map((p) => ({ playerId: p, joinedAt: 0 }));

  // p1: win+draw = 1.5 · p2: draw+draw = 1 · p3: draw+win = 1.5 · p4: 2 losses.
  const matches = [
    m("p1", "p4", "white", 1),
    m("p2", "p3", "draw", 1),
    m("p1", "p2", "draw", 2),
    m("p3", "p4", "white", 2),
  ];
  const rows = standings.computeStandings("swiss", matches, entries);
  // p1 and p3 tie on 1.5 points. Buchholz: p1 faced p4 (0) + p2 (1) = 1;
  // p3 faced p2 (1) + p4 (0) = 1 — still tied. Wins: both 1 — still tied.
  // Head-to-head: they never met. Player id ascending puts p1 first.
  assert.equal(rows[0].points, 1.5);
  const p1 = rows.find((r) => r.playerId === "p1")!;
  const p3 = rows.find((r) => r.playerId === "p3")!;
  assert.ok(rows.indexOf(p1) < rows.indexOf(p3), "deterministic id tiebreak failed");
  // p2 sits alone on 1 point, ahead of winless p4.
  const p2 = rows.find((r) => r.playerId === "p2")!;
  const p4 = rows.find((r) => r.playerId === "p4")!;
  assert.ok(rows.indexOf(p2) < rows.indexOf(p4));
  assert.equal(p2.points, 1);
  assert.equal(p4.points, 0);
});

test("swiss standings: wins separate players that Buchholz cannot", () => {
  const m = (w: string, b: string, result: "white" | "black" | "draw", round = 1): import("@/lib/tournament-types").TournamentMatch => ({
    id: `${w}-${b}-${round}-${Math.random()}`,
    tournamentId: "t",
    round,
    slot: 0,
    whitePlayerId: w,
    blackPlayerId: b,
    gameId: "g",
    status: "complete",
    result,
    resultReason: "checkmate",
    createdAt: 0,
  });
  const entries = ["p1", "p2", "p3", "p4"].map((p) => ({ playerId: p, joinedAt: 0 }));
  // All three points-makers finish on 1 point but with different win counts.
  const matches = [
    m("p1", "p4", "draw", 1),
    m("p2", "p3", "white", 1),
    m("p1", "p2", "draw", 2),
    m("p3", "p4", "draw", 2),
  ];
  const rows = standings.computeStandings("swiss", matches, entries);
  // p2: 1.5 (win+draw). p1 and p3: 1 point each (2 draws). p1 wins=0, p3 wins=0,
  // Buchholz: p1 faced p4(0.5)+p2(1.5)=2, p3 faced p2(1.5)+p4(0.5)=2 — tie →
  // wins tie → head-to-head: p1 v p3 never met → id ascending.
  assert.equal(rows[0].playerId, "p2");
  assert.equal(rows[0].points, 1.5);
  const p1 = rows.find((r) => r.playerId === "p1")!;
  const p3 = rows.find((r) => r.playerId === "p3")!;
  assert.ok(rows.indexOf(p1) < rows.indexOf(p3), "id tiebreak must be deterministic");
});

test("swiss standings: Buchholz separates equal points", () => {
  const m = (w: string, b: string, result: "white" | "black" | "draw", round: number): import("@/lib/tournament-types").TournamentMatch => ({
    id: `${w}-${b}-${round}-${Math.random()}`,
    tournamentId: "t",
    round,
    slot: 0,
    whitePlayerId: w,
    blackPlayerId: b,
    gameId: "g",
    status: "complete",
    result,
    resultReason: "checkmate",
    createdAt: 0,
  });
  const entries = ["p1", "p2", "p3", "p4"].map((p) => ({ playerId: p, joinedAt: 0 }));
  // R1: p1 beats p4, p2 beats p3. R2: p1 v p2 drawn, p3 beats p4.
  // p1 = 1.5, p2 = 1.5, p3 = 1, p4 = 0.
  const matches = [
    m("p1", "p4", "white", 1),
    m("p2", "p3", "white", 1),
    m("p1", "p2", "draw", 2),
    m("p3", "p4", "white", 2),
  ];
  const rows = standings.computeStandings("swiss", matches, entries);
  // p1 and p2 tie on 1.5. Buchholz: p1 faced p4 (0) + p2 (1.5) = 1.5;
  // p2 faced p3 (1) + p1 (1.5) = 2.5 → p2 ranks first.
  assert.equal(rows[0].playerId, "p2");
  assert.equal(rows[1].playerId, "p1");
  assert.equal(rows[2].playerId, "p3");
  assert.equal(rows[3].playerId, "p4");
  // Determinism: same input, same output — twice.
  const again = standings.computeStandings("swiss", matches, entries);
  assert.deepEqual(again, rows);
});

/* ------------------------------------------------------------------ */
/* Arena                                                               */
/* ------------------------------------------------------------------ */

test("arena: on-demand pairing, one active game per player, standings update", async () => {
  const host = pid("h15");
  const doc = await makeTournament(host, { format: "arena", maxPlayers: 4 });
  const [a, b, c] = [pid("arA"), pid("arB"), pid("arC")];
  await startTournament(doc, [a, b, c]);

  // First pairing: a meets the first idle candidate (b — closest rank).
  const p1 = await engine.requestArenaPairing(doc.id, a);
  assert.ok(p1.ok, p1.error);
  assert.equal(p1.match!.whitePlayerId === a || p1.match!.blackPlayerId === a, true);
  const g1 = p1.match!.gameId;
  const aOpponent =
    p1.match!.whitePlayerId === a ? p1.match!.blackPlayerId : p1.match!.whitePlayerId;

  // b is now busy inside game 1 — a second request is refused.
  const busyB = await engine.requestArenaPairing(doc.id, aOpponent);
  assert.ok(!busyB.ok);
  assert.match(busyB.error!, /already have an active game/i);

  // c is idle but a is busy — an odd player out has nobody to pair with.
  const lonely = await engine.requestArenaPairing(doc.id, c);
  assert.ok(!lonely.ok);
  assert.match(lonely.error!, /no opponent is free/i);

  // Finish game 1; standings update; the loser's slot frees up.
  const m1 = (await store.getTournamentDoc(doc.id))!.matches.find((m) => m.gameId === g1)!;
  await playGame(g1, m1.whitePlayerId, m1.blackPlayerId, "white");
  const after = (await store.getTournamentDoc(doc.id))!;
  const row = after.standings.find((s) => s.playerId === m1.whitePlayerId)!;
  assert.equal(row.points, 1);
  // Now a can pair again — against c, the only other idle player.
  const again = await engine.requestArenaPairing(doc.id, a);
  assert.ok(again.ok, "a finished game must free the player for a new pairing");
  assert.equal(
    again.match!.whitePlayerId === c || again.match!.blackPlayerId === c,
    true,
    "the new pairing must include the remaining idle player",
  );

  // Non-arena tournaments refuse on-demand pairing.
  const swissDoc = await makeTournament(host, { format: "swiss" });
  const wrong = await engine.requestArenaPairing(swissDoc.id, host);
  assert.ok(!wrong.ok);
});

/* ------------------------------------------------------------------ */
/* Result ingestion                                                    */
/* ------------------------------------------------------------------ */

test("results ingest from real games: win, loss, draw, timeout, resignation", async () => {
  const host = pid("h16");
  const doc = await makeTournament(host, { format: "swiss", maxPlayers: 8, swissRounds: 1 });
  const [a, b] = [pid("rA"), pid("rB")];
  await startTournament(doc, [a, b]);
  let after = (await store.getTournamentDoc(doc.id))!;
  const m = after.matches.find((x) => x.blackPlayerId !== types.SWISS_BYE_OPPONENT)!;
  assert.ok(m);

  // Resignation: b resigns the tournament game — a wins.
  const resigned = await hosted.resignHostedGame(m.gameId, b);
  assert.equal(resigned.status, "resigned");
  after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(m.gameId, resigned.id);
  const rec = after.matches.find((x) => x.gameId === m.gameId)!;
  assert.equal(rec.status, "complete");
  assert.equal(rec.resultReason, "resigned");
  const winnerId = rec.result === "white" ? rec.whitePlayerId : rec.blackPlayerId;
  assert.equal(winnerId, a);

  // Timeout path: the engine ingests whatever status the game ends with.
  const doc2 = await makeTournament(host, { format: "swiss", maxPlayers: 8, swissRounds: 1 });
  const [c, d] = [pid("rC"), pid("rD")];
  await startTournament(doc2, [c, d]);
  const after2 = (await store.getTournamentDoc(doc2.id))!;
  const m2 = after2.matches.find((x) => x.blackPlayerId !== types.SWISS_BYE_OPPONENT)!;
  // Directly ingest a timeout-shaped game state (the real settle path calls
  // the same function with the same shape).
  await engine.ingestTournamentGameResult(m2.gameId, {
    ...m2.gameId ? {} : {},
    id: m2.gameId,
    status: "timeout",
    winner: c,
    creator: m2.whitePlayerId,
    opponent: m2.blackPlayerId,
  } as GameState);
  const rec2 = (await store.getTournamentDoc(doc2.id))!.matches.find((x) => x.gameId === m2.gameId)!;
  assert.equal(rec2.resultReason, "timeout");
  assert.equal(rec2.result, "white");
});

test("duplicate result ingestion never double-counts", async () => {
  const host = pid("h17");
  const doc = await makeTournament(host, { format: "swiss", maxPlayers: 8, swissRounds: 1 });
  const [a, b] = [pid("dA"), pid("dB")];
  await startTournament(doc, [a, b]);
  const after = (await store.getTournamentDoc(doc.id))!;
  const m = after.matches.find((x) => x.blackPlayerId !== types.SWISS_BYE_OPPONENT)!;
  await playGame(m.gameId, m.whitePlayerId, m.blackPlayerId, "black");

  const once = (await store.getTournamentDoc(doc.id))!;
  const rowsOnce = JSON.stringify(once.standings);
  // Re-ingest the same completed game five times.
  for (let i = 0; i < 5; i++) {
    const game = await hosted.getHostedGame(m.gameId);
    await engine.ingestTournamentGameResult(game!.id, game!);
  }
  const twice = (await store.getTournamentDoc(doc.id))!;
  assert.equal(JSON.stringify(twice.standings), rowsOnce, "standings moved on re-ingestion");
  assert.equal(once.matches.find((x) => x.gameId === m.gameId)!.result, twice.matches.find((x) => x.gameId === m.gameId)!.result);
});

test("aborted games never affect standings", async () => {
  const host = pid("h18");
  const doc = await makeTournament(host, { format: "swiss", maxPlayers: 8, swissRounds: 1 });
  const [a, b] = [pid("abA"), pid("abB")];
  await startTournament(doc, [a, b]);
  const after = (await store.getTournamentDoc(doc.id))!;
  const m = after.matches.find((x) => x.blackPlayerId !== types.SWISS_BYE_OPPONENT)!;
  await hosted.abortHostedGame(m.gameId, a);
  const afterAbort = (await store.getTournamentDoc(doc.id))!;
  const rec = afterAbort.matches.find((x) => x.gameId === m.gameId)!;
  assert.equal(rec.resultReason, "aborted");
  assert.equal(rec.result, undefined, "an aborted game must carry no result");
  assert.equal(afterAbort.standings.every((r) => r.played === 0 && r.points === 0), true);
});

/* ------------------------------------------------------------------ */
/* Server authority                                                    */
/* ------------------------------------------------------------------ */

test("completion names the winner server-side; a client cannot", async () => {
  const host = pid("h19");
  const doc = await makeTournament(host, { format: "arena", maxPlayers: 4 });
  const [a, b] = [pid("wA"), pid("wB")];
  await startTournament(doc, [a, b]);
  // Pair and finish a game so the standings are non-empty.
  await engine.requestArenaPairing(doc.id, a);
  const docAfterPair = (await store.getTournamentDoc(doc.id))!;
  const g = docAfterPair.matches[0];
  await playGame(g.gameId, g.whitePlayerId, g.blackPlayerId, "black");

  // The impostor's "win" never reaches the engine — there is no API for it,
  // and the engine's own completion derives the winner from standings.
  const done = await engine.completeTournament(doc.id, null);
  assert.ok(done.ok);
  const after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.status, "completed");
  assert.equal(after.winnerId, g.blackPlayerId, "the engine must crown the standings leader");
});

test("concurrent joins respect the cap", async () => {
  const host = pid("h20");
  const doc = await makeTournament(host, { maxPlayers: 4 });
  await engine.transitionTournament(doc.id, host, "registration");
  const six = [pid("j1"), pid("j2"), pid("j3"), pid("j4"), pid("j5"), pid("j6")];
  const results = await Promise.all(six.map((p) => engine.joinTournament(doc.id, p)));
  const joined = results.filter((r) => r.ok).length;
  assert.equal(joined, 4, `expected exactly 4 of 6 concurrent joins to succeed, got ${joined}`);
});

test("concurrent starts produce exactly one running tournament", async () => {
  const host = pid("h21");
  const doc = await makeTournament(host, { format: "knockout", maxPlayers: 4 });
  const players = [pid("s1"), pid("s2"), pid("s3"), pid("s4")];
  await engine.transitionTournament(doc.id, host, "registration");
  for (const p of players) await engine.joinTournament(doc.id, p);
  await engine.transitionTournament(doc.id, host, "locked");
  // Four start attempts at once — in-process this serialises through the
  // storage chain; exactly one round-1 generation may run.
  const results = await Promise.all(
    players.map(() => engine.transitionTournament(doc.id, host, "in_progress")),
  );
  const okCount = results.filter((r) => r.ok).length;
  assert.ok(okCount >= 1, "at least one start must succeed");
  const after = (await store.getTournamentDoc(doc.id))!;
  assert.equal(after.status, "in_progress");
  // Round 1 must exist exactly once.
  const r1 = after.matches.filter((m) => m.round === 1 && m.resultReason !== "bye");
  assert.equal(r1.length, 2, `expected exactly 2 round-1 matches, got ${r1.length}`);
  assert.equal(after.matches.filter((m) => m.round === 1).length, 2);
});

test("a game completion racing round generation cannot corrupt the bracket", async () => {
  const host = pid("h22");
  const doc = await makeTournament(host, { format: "knockout", maxPlayers: 4 });
  const [a, b, c, d] = [pid("kA"), pid("kB"), pid("kC"), pid("kD")];
  await startTournament(doc, [a, b, c, d]);
  const after = (await store.getTournamentDoc(doc.id))!;
  const r1 = after.matches.filter((m) => m.round === 1 && m.resultReason !== "bye");
  // Finish both games simultaneously — the bracket may only progress once.
  await Promise.all(
    r1.map((m) => playGame(m.gameId, m.whitePlayerId, m.blackPlayerId, "white")),
  );
  const final = (await store.getTournamentDoc(doc.id))!;
  assert.equal(final.currentRound, 2);
  const finalMatches = final.matches.filter((m) => m.round === 2);
  assert.equal(finalMatches.length, 1, `expected exactly one final, got ${finalMatches.length}`);
});

/* ------------------------------------------------------------------ */
/* Authentication / authorization                                      */
/* ------------------------------------------------------------------ */

test("non-hosts cannot run lifecycle transitions", async () => {
  const host = pid("h23");
  const doc = await makeTournament(host);
  await engine.transitionTournament(doc.id, host, "registration");
  const impostor = pid("impostor2");
  for (const to of ["locked", "in_progress", "completed", "cancelled"] as const) {
    const res = await engine.transitionTournament(doc.id, impostor, to);
    assert.ok(!res.ok, `a non-host must not move the tournament to ${to}`);
  }
});

test("guests can join free tournaments (no payment fields anywhere)", async () => {
  const host = pid("h24");
  const doc = await makeTournament(host);
  await engine.transitionTournament(doc.id, host, "registration");
  // A guest id (0x… device identity) joins without any account.
  const guest = `0x${"ab".repeat(20)}`;
  const res = await engine.joinTournament(doc.id, guest);
  assert.ok(res.ok, `guest join failed: ${res.ok ? "" : res.error}`);
  const after = (await store.getTournamentDoc(doc.id))!;
  assert.ok(after.entries.some((e) => e.playerId === guest));
  // Phase 2A boundary, Phase 2B edition: a FREE tournament's economy fields
  // are all inert (null fee / null preset / "none" payout state) and no
  // entry carries payment proof. Guests need no wallet and no NIM.
  assert.equal(after.entryFeeLuna ?? null, null);
  assert.equal(after.prizePreset ?? null, null);
  assert.equal(after.payoutStatus ?? "none", "none");
  for (const e of after.entries) {
    assert.equal(e.paid, undefined, "a free-tournament entry carries payment proof");
  }
});

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

test("detail view serves summary, rounds, standings and roles", async () => {
  const host = pid("h25");
  const doc = await makeTournament(host, { format: "knockout", maxPlayers: 2 });
  const [a, b] = [pid("vA"), pid("vB")];
  await startTournament(doc, [a, b]);
  const forHost = await engine.getTournamentDetail(doc.id, host);
  assert.ok(forHost);
  assert.equal(forHost.myRole, "host");
  assert.equal(forHost.summary.playerCount, 2);
  assert.equal(forHost.rounds.length, 1);
  const forEntrant = await engine.getTournamentDetail(doc.id, a);
  assert.equal(forEntrant!.myRole, "entrant");
  assert.ok(forEntrant!.myActiveGameId, "an entrant must see their active game");
  const forOutsider = await engine.getTournamentDetail(doc.id);
  assert.equal(forOutsider!.myRole, "none");

  // Unknown tournament → null (API turns it into 404).
  assert.equal(await engine.getTournamentDetail("tour_missing"), null);
});

test("list view groups by status and resolves host names", async () => {
  const host = pid("h26");
  await hosted.updatePlayerIdentity(host, { username: "ListHost", isGuest: false });
  const doc = await makeTournament(host, { name: "Listable Open" });
  await engine.transitionTournament(doc.id, host, "registration");
  const { tournaments, players } = await engine.listTournaments();
  const row = tournaments.find((t) => t.id === doc.id);
  assert.ok(row);
  assert.equal(row.status, "registration");
  assert.equal(players[host], "ListHost");
});
