/**
 * Pen/stress pass over the live game path, added alongside the poll-mirror
 * throttle fix. These are NOT fixtures: they drive the real hosted backend
 * (file store, real chess validation, real clock settlement) the way the
 * client does — create, join, poll bursts, moves, terminal states.
 *
 * Scenarios pinned here:
 *  1. Concurrent poll storm on a live game — every poll must return a
 *     consistent, playable position and never throw.
 *  2. Concurrent moves: only the side-to-move's move wins; the loser gets a
 *     clean rejection, never a corrupted board.
 *  3. A move racing a poll cannot rewind the position.
 *  4. Resignation and abort are terminal and idempotent under races.
 *  5. Draw offer/accept race ends the game exactly once.
 *  6. Flag-fall settlement under a poll burst ends the game once.
 *  7. Rematch leaves the finished game finished and opens a fresh board.
 *  8. Tournament match ingest is idempotent under double processing.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GameState } from "@/lib/types";

let DATA_ROOT: string;
let hosted: typeof import("@/lib/server/hosted");
let engine: typeof import("@/lib/server/tournaments");

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-stress-"));
  process.chdir(DATA_ROOT);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Synchronous round progression, pinned before first import (see
  // tournaments.test.ts for the contract).
  // The sandbox env carries real Nimiq treasury keys that turn on the paid-
  // tournament machinery; a bare test env must look unconfigured, exactly
  // like the other suites.
  for (const k of [
    "NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS",
    "NIMIQ_TREASURY_ADDRESS",
    "NIMIQ_PAYOUT_TREASURY_ADDRESS",
    "NIMIQ_RPC_URL",
  ]) {
    delete process.env[k];
  }
  process.env.TOURNAMENT_ROUND_INTERMISSION_MS = "0";
  hosted = await import("@/lib/server/hosted");
  engine = await import("@/lib/server/tournaments");

  // The hosting gate reads a linked wallet + on-chain balance. Tests run
  // without a Nimiq node — inject the same always-passing seam the engine
  // suite uses.
  engine.setTournamentCreationGateDeps({
    getLinkedWallet: async (playerId: string) => ({
      address: `NQ07_TEST_${playerId}`.slice(0, 36).padEnd(36, "0"),
      network: "test",
    }),
    getAccountBalanceLuna: async () => BigInt(1000) * BigInt(100_000),
    // Every test player is a signed-in account (no profile store in tests).
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

let seq = 0;
function ids(): [string, string] {
  seq += 1;
  return [`acct_stress_w${seq}`, `acct_stress_b${seq}`];
}

/** A live 10+0 game between two accounts, both present. */
async function liveGame(): Promise<GameState> {
  const [white, black] = ids();
  const created = await hosted.createHostedGame(white, { timeControl: "10 + 0" });
  return hosted.joinHostedGame(created.id, black);
}

test("poll storm: 40 concurrent reads of a live game stay consistent", async () => {
  const game = await liveGame();
  const polls = await Promise.all(
    Array.from({ length: 40 }, () => hosted.getHostedGame(game.id)),
  );
  for (const state of polls) {
    assert.ok(state, "a poll must never lose the game");
    assert.equal(state.id, game.id);
    assert.equal(state.fen, game.fen, "an idle game's position must not drift");
    assert.equal(state.status, "active");
  }
});

test("concurrent moves from both sides: exactly one is accepted", async () => {
  const game = await liveGame();
  // Both players "click at the same time" — only White is to move.
  const results = await Promise.allSettled([
    hosted.submitHostedMove(game.id, game.creator, "e2", "e4"),
    hosted.submitHostedMove(game.id, game.opponent!, "e7", "e5"),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(
    fulfilled.length,
    1,
    "exactly one of two simultaneous moves may be accepted",
  );
  // The accepted move must be White's (the side to move).
  const after = await hosted.getHostedGame(game.id);
  assert.ok(after);
  assert.equal(after.moves.length, 1);
  assert.equal(after.moves[0].from, "e2");
  assert.equal(after.moves[0].to, "e4");
});

test("a move racing polls cannot rewind the position", async () => {
  const game = await liveGame();
  const move = hosted.submitHostedMove(game.id, game.creator, "d2", "d4");
  const polls = Promise.all(
    Array.from({ length: 10 }, () => hosted.getHostedGame(game.id)),
  );
  await Promise.all([move, polls]);
  const final = await hosted.getHostedGame(game.id);
  assert.ok(final);
  assert.equal(final.moves.length, 1, "the move must survive the poll storm");
  assert.equal(final.moves[0].san, "d4");
});

test("resignation under concurrent polls is terminal exactly once", async () => {
  const game = await liveGame();
  const [resigned] = await Promise.all([
    hosted.resignHostedGame(game.id, game.opponent!),
    Promise.all(Array.from({ length: 8 }, () => hosted.getHostedGame(game.id))),
  ]);
  assert.equal(resigned.status, "resigned");
  assert.equal(resigned.winner, game.creator);

  // A late poll can never reopen it, and a second resign is rejected.
  const after = await hosted.getHostedGame(game.id);
  assert.equal(after!.status, "resigned");
  await assert.rejects(
    () => hosted.resignHostedGame(game.id, game.creator),
    /finished|over|ended|not active/i,
  );
});

test("draw offer + acceptance race ends the game exactly once", async () => {
  const game = await liveGame();
  await hosted.offerDrawHostedGame(game.id, game.creator);
  const [accepted] = await Promise.all([
    hosted.respondHostedDraw(game.id, game.opponent!, true),
    Promise.all(Array.from({ length: 8 }, () => hosted.getHostedGame(game.id))),
  ]);
  assert.equal(accepted.status, "draw");
  const after = await hosted.getHostedGame(game.id);
  assert.equal(after!.status, "draw");
});

test("abort before the opponent sits is terminal and blocks joiners", async () => {
  const [white] = ids();
  const created = await hosted.createHostedGame(white, { visibility: "private" });
  const aborted = await hosted.abortHostedGame(created.id, white);
  assert.equal(aborted.status, "aborted");
  const after = await hosted.getHostedGame(created.id);
  assert.equal(after!.status, "aborted");
  await assert.rejects(
    () => hosted.joinHostedGame(created.id, `guest_x_${seq}_${Math.random()}`),
    /finished|over|ended|not active|aborted|full|waiting/i,
  );
});

test("flag fall settles exactly once under a poll burst", async () => {
  const [white, black] = ids();
  // "0m 0.05s" parses via the min-sec form: a 50ms clock. Presence gates the
  // clock start (60s grace), so arrive both sides explicitly like the client
  // does for tournament boards, then burst polls until the sweep fires.
  const created = await hosted.createHostedGame(white, { timeControl: "0m 0.05s" });
  await hosted.joinHostedGame(created.id, black);
  await hosted.arriveHostedGame(created.id, white);
  await hosted.arriveHostedGame(created.id, black);
  // A real client polls on a cadence, not back-to-back — pace the burst so
  // it outlives the 50ms clock.
  await new Promise((r) => setTimeout(r, 80));
  let settled: GameState | null = null;
  for (let i = 0; i < 50 && !settled; i++) {
    const state = await hosted.getHostedGame(created.id);
    if (state && state.status === "timeout") settled = state;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(settled, "the flag must fall within the poll burst");
  assert.equal(settled!.winner, black, "White ran out first — Black wins on time");
  const after = await hosted.getHostedGame(created.id);
  assert.equal(after!.status, "timeout", "a settled game stays settled");
});

test("rematch produces a fresh game and never touches the finished one", async () => {
  const game = await liveGame();
  await hosted.resignHostedGame(game.id, game.opponent!);
  const rematch = await hosted.rematchHostedGame(game.id, game.creator);
  assert.notEqual(rematch.id, game.id);
  assert.equal(rematch.status, "active", "rematch deals a fresh board immediately");
  assert.equal(rematch.creator, game.creator, "the requester deals the fresh board");
  assert.equal(rematch.opponent, game.opponent);
  const original = await hosted.getHostedGame(game.id);
  assert.equal(original!.status, "resigned", "the finished game must stay finished");
});

test("tournament match ingest is idempotent under double processing", async () => {
  // Knockout flow end-to-end at small scale: create → open → fill → start,
  // then play round 1 through the real hosted game path.
  const [a, b] = ids();
  const created = await engine.createTournament(a, {
    name: "Stress KO",
    format: "knockout",
    timeControl: "5 + 0",
    maxPlayers: 2,
  });
  const opened = await engine.transitionTournament(created.id, a, "registration");
  assert.ok(opened.ok, `open registration: ${opened.ok ? "ok" : opened.error}`);
  const j1 = await engine.joinTournament(created.id, a);
  assert.ok(j1.ok, `host joins: ${j1.ok ? "ok" : j1.error}`);
  const j2 = await engine.joinTournament(created.id, b);
  assert.ok(j2.ok, `opponent joins: ${j2.ok ? "ok" : j2.error}`);
  const started = await engine.transitionTournament(created.id, a, "in_progress");
  assert.ok(started.ok, `start: ${started.ok ? "ok" : started.error}`);
  const detail = await engine.getTournamentDetail(created.id, a);
  const match = detail?.rounds?.flatMap((r) => r.matches)[0];
  assert.ok(match, "starting a 2-player knockout must generate a match");
  assert.ok(match.gameId, "the match must be bound to a hosted game");

  const g = await hosted.getHostedGame(match.gameId!);
  assert.ok(g, "the match's hosted game must exist");
  const white = g.creator;
  const black = g.opponent!;
  const moves: [string, string][] = [
    ["f2", "f3"],
    ["e7", "e5"],
    ["g2", "g4"],
    ["d8", "h4"],
  ];
  for (const [i, [from, to]] of moves.entries()) {
    await hosted.submitHostedMove(g.id, i % 2 === 0 ? white : black, from, to);
  }
  const finished = await hosted.getHostedGame(g.id);
  assert.equal(finished!.status, "checkmate");

  // Re-ingest the same terminal result — the double-count guard must hold.
  await engine.ingestTournamentGameResult(g.id, finished!);
  await engine.ingestTournamentGameResult(g.id, finished!);
  const after = await engine.getTournamentDetail(created.id, a);
  const standings = after?.standings ?? [];
  const totalPlayed = standings.reduce(
    (sum: number, s: { gamesPlayed?: number; played?: number }) =>
      sum + (s.gamesPlayed ?? s.played ?? 0),
    0,
  );
  assert.ok(
    totalPlayed <= 2,
    `double ingest must not double-count games, saw ${totalPlayed}`,
  );
});
