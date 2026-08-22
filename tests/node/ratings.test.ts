/**
 * Integration test for rated play — "the ELO rating never changes".
 *
 * Two independent defects produced that symptom, and both are pinned here:
 *
 *  1. `applyRatingsIfFinished` declines to rate any game involving a guest,
 *     and account-hood was read from a per-instance cache blob that could say
 *     `isGuest: true` long after the player had an account. See
 *     `reconcileWithProfile` — a `profiles` row now decides it outright.
 *  2. The client played under the wrong player id (identity-context.tsx), so
 *     the account's own record was never the one being rated. That half lives
 *     in React and is covered by the reasoning in that file rather than here.
 *
 * The tests below drive the real hosted backend, real game logic, real Glicko
 * maths and the real file store — nothing about the rating path is stubbed.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProfileRow } from "@/lib/supabase/db";
import type { GameState, PlayerStats } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/* Same shape as hosted-analysis.test.ts: move cwd before the file store's
   module ever loads, and give the test its own throwaway .data/ root. */
let DATA_ROOT: string;
let hosted: typeof import("@/lib/server/hosted");

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-ratings-"));
  process.chdir(DATA_ROOT);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  hosted = await import("@/lib/server/hosted");

  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

/** A distinct pair of ids per test, so no two tests share a stats record. */
let seq = 0;
function pair(): [string, string] {
  seq += 1;
  return [`acct_w${seq}`, `acct_b${seq}`];
}

/** Register a player as a real account holder, exactly as /api/identity/link does. */
async function account(playerId: string, username: string): Promise<PlayerStats> {
  return hosted.updatePlayerIdentity(playerId, { username, isGuest: false });
}

/** Register a player who never signed up — the default state. */
async function guest(playerId: string, username: string): Promise<PlayerStats> {
  return hosted.updatePlayerIdentity(playerId, { username, isGuest: true });
}

async function playedGame(white: string, black: string): Promise<GameState> {
  const created = await hosted.createHostedGame(white, { visibility: "private" });
  await hosted.joinHostedGame(created.id, black);
  /* 1. f3 e5 2. g4 Qh4# — fool's mate, so Black (the joiner) wins by a real
     checkmate rather than by a synthetic status poke. */
  const moves: [string, string][] = [
    ["f2", "f3"],
    ["e7", "e5"],
    ["g2", "g4"],
    ["d8", "h4"],
  ];
  let state: GameState | null = null;
  for (const [i, [from, to]] of moves.entries()) {
    state = await hosted.submitHostedMove(created.id, i % 2 === 0 ? white : black, from, to);
  }
  return state!;
}

/* ------------------------------------------------------------------ */
/* The reported bug: a finished game must move both ratings           */
/* ------------------------------------------------------------------ */

test("a rated game between two accounts updates both players' ratings", async () => {
  const [white, black] = pair();
  await account(white, "Magnus_T");
  await account(black, "Hikaru_T");

  const before = await Promise.all([
    hosted.getPlayerStats(white),
    hosted.getPlayerStats(black),
  ]);
  assert.equal(before[0].rating, 1200, "both players start provisional");
  assert.equal(before[1].rating, 1200);

  const finished = await playedGame(white, black);
  assert.equal(finished.status, "checkmate");
  assert.equal(finished.winner, black, "Black delivers fool's mate");

  const [w, b] = await Promise.all([
    hosted.getPlayerStats(white),
    hosted.getPlayerStats(black),
  ]);

  /* The headline assertion: the rating actually moved. */
  assert.notEqual(w.rating, 1200, "the loser's rating never changed");
  assert.notEqual(b.rating, 1200, "the winner's rating never changed");
  assert.ok(b.rating > 1200, `winner should gain, got ${b.rating}`);
  assert.ok(w.rating < 1200, `loser should lose points, got ${w.rating}`);

  /* And the rest of the record moved with it — a rating change with a zero
     game count is how a half-applied update would look. */
  assert.equal(w.games, 1);
  assert.equal(b.games, 1);
  assert.equal(b.wins, 1);
  assert.equal(w.losses, 1);
  assert.equal(b.currentStreak, 1);
  assert.equal(w.currentStreak, -1);
  assert.equal(b.peakRating, b.rating);
});

test("the profile endpoint serves the updated rating", async () => {
  const [white, black] = pair();
  await account(white, "Fabiano_T");
  await account(black, "Ding_T");
  await playedGame(white, black);

  /* getPlayerProfile is what GET /api/hosted/players/me returns, which is what
     both the profile page and the header rating chip read. */
  const profile = await hosted.getPlayerProfile(black);
  assert.ok(profile.stats.rating > 1200, "the profile still shows the provisional 1200");
  assert.equal(profile.stats.games, 1);
  assert.ok(
    profile.games.some((g) => g.winner === black),
    "the won game is missing from the profile's game list",
  );
});

test("the game records both rating deltas for the result screen", async () => {
  const [white, black] = pair();
  await account(white, "Anish_T");
  await account(black, "Wesley_T");

  const finished = await playedGame(white, black);

  /* The end-game modal reads these off the game itself, so they must be
     stamped on rather than left for the stats cache to supply. */
  assert.ok(finished.ratings, "no rating deltas were stamped onto the game");
  const wd = finished.ratings![white];
  const bd = finished.ratings![black];
  assert.equal(wd.before, 1200);
  assert.equal(bd.before, 1200);
  assert.equal(bd.change, bd.after - bd.before);
  assert.ok(bd.change > 0, "the winner's delta should be positive");
  assert.ok(wd.change < 0, "the loser's delta should be negative");
});

test("rating history records the game, so the profile can chart it", async () => {
  const [white, black] = pair();
  await account(white, "Levon_T");
  await account(black, "Alireza_T");

  const finished = await playedGame(white, black);
  const winner = await hosted.getPlayerStats(black);

  assert.equal(winner.ratingHistory.length, 1);
  const entry = winner.ratingHistory[0];
  assert.equal(entry.gameId, finished.id);
  assert.equal(entry.ratingBefore, 1200);
  assert.equal(entry.ratingAfter, winner.rating);
  assert.equal(entry.opponentRating, 1200);
  assert.equal(entry.change, winner.rating - 1200);
});

test("a rated win appears on the leaderboard", async () => {
  const [white, black] = pair();
  await account(white, "Board_A");
  await account(black, "Board_B");
  await playedGame(white, black);

  const board = await hosted.getLeaderboard();
  const row = board.find((p) => p.playerId === black);
  assert.ok(row, "the winner is missing from the leaderboard");
  assert.ok(row!.rating > 1200);
});

/* ------------------------------------------------------------------ */
/* Guests stay casual — the intended behaviour, not the bug            */
/* ------------------------------------------------------------------ */

test("a game involving a guest stays casual", async () => {
  const [white, black] = pair();
  await account(white, "Real_Account");
  await guest(black, "Guest_99");

  const finished = await playedGame(white, black);

  const [w, b] = await Promise.all([
    hosted.getPlayerStats(white),
    hosted.getPlayerStats(black),
  ]);
  assert.equal(w.rating, 1200, "an account must not be rated against a guest");
  assert.equal(b.rating, 1200);
  assert.equal(w.games, 0);
  assert.equal(finished.ratings, undefined, "a casual game must stamp no deltas");
});

test("an aborted game is never rated", async () => {
  const [white, black] = pair();
  await account(white, "Abort_W");
  await account(black, "Abort_B");

  const created = await hosted.createHostedGame(white, { visibility: "private" });
  await hosted.joinHostedGame(created.id, black);
  const aborted = await hosted.abortHostedGame(created.id, white);

  assert.equal(aborted.status, "aborted");
  const w = await hosted.getPlayerStats(white);
  assert.equal(w.games, 0, "an aborted game must not count");
  assert.equal(w.rating, 1200);
});

test("ratings are applied exactly once per game", async () => {
  const [white, black] = pair();
  await account(white, "Once_W");
  await account(black, "Once_B");

  const finished = await playedGame(white, black);
  const afterFirst = await hosted.getPlayerStats(black);

  /* Resigning an already-finished game is refused, and the second end-game
     path must not re-apply the result either way. */
  await assert.rejects(() => hosted.resignHostedGame(finished.id, white));
  const afterSecond = await hosted.getPlayerStats(black);

  assert.equal(afterSecond.rating, afterFirst.rating);
  assert.equal(afterSecond.games, 1, "the game was counted twice");
});

/* ------------------------------------------------------------------ */
/* The root cause: account-hood comes from the durable profile         */
/* ------------------------------------------------------------------ */

/** A profiles row as Supabase serves it. `updatedAt` deliberately varies. */
function profileRow(playerId: string, over: Partial<ProfileRow> = {}): ProfileRow {
  return {
    user_id: `user-${playerId}`,
    player_id: playerId,
    username: "Durable_Name",
    is_guest: false,
    rating: 1500,
    rd: 80,
    last_played_at: 1_700_000_000_000,
    country: null,
    peak_rating: 1520,
    wins: 12,
    losses: 4,
    draws: 2,
    games: 18,
    current_streak: 3,
    best_streak: 5,
    created_at: new Date(1_600_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
    ...over,
  };
}

function cachedBlob(over: Partial<PlayerStats> = {}): PlayerStats {
  return {
    playerId: "acct_reconcile",
    isGuest: true,
    rating: 1200,
    rd: 350,
    lastPlayedAt: null,
    peakRating: 1200,
    wins: 0,
    losses: 0,
    draws: 0,
    games: 0,
    currentStreak: 0,
    bestStreak: 0,
    ratingHistory: [],
    achievements: [],
    /* Newer than the profile row — the exact condition that made the stale
       blob authoritative and every game casual. */
    updatedAt: 1_800_000_000_000,
    ...over,
  };
}

test("a stale cache cannot demote an account holder to a guest", () => {
  const reconciled = hosted.reconcileWithProfile(cachedBlob(), profileRow("acct_reconcile"));

  /* This single assertion is the whole bug: with the old freshness-gated
     version the blob won outright and isGuest stayed true. */
  assert.equal(reconciled.isGuest, false, "the account was still treated as a guest");
  assert.equal(reconciled.username, "Durable_Name");

  /* Counters still respect the newer cache — account-hood is not a race, a
     rating is. Adopting the row's 1500 here would undo a game the player just
     finished on this instance. */
  assert.equal(reconciled.rating, 1200);
  assert.equal(reconciled.games, 0);
});

test("a newer profile row wins for the rating itself", () => {
  const stale = cachedBlob({ updatedAt: 1_650_000_000_000 });
  const reconciled = hosted.reconcileWithProfile(stale, profileRow("acct_reconcile"));

  assert.equal(reconciled.isGuest, false);
  assert.equal(reconciled.rating, 1500, "a newer durable rating must be adopted");
  assert.equal(reconciled.games, 18);
  assert.equal(reconciled.rd, 80);
  assert.equal(reconciled.peakRating, 1520);
  /* History and achievements only ever exist in the cached copy. */
  assert.deepEqual(reconciled.ratingHistory, []);
});

test("no profile row means guest, whatever the cache says", () => {
  const optimistic = cachedBlob({ isGuest: false, rating: 1400 });
  const reconciled = hosted.reconcileWithProfile(optimistic, null);

  /* Deleting an account removes the row, so "no row" has to leave the cached
     value alone rather than assert an account exists. */
  assert.equal(reconciled, optimistic, "the stats must pass through untouched");
});

test("a profile row marked guest keeps the game casual", () => {
  const reconciled = hosted.reconcileWithProfile(
    cachedBlob({ isGuest: false }),
    profileRow("acct_reconcile", { is_guest: true }),
  );
  assert.equal(reconciled.isGuest, true, "the durable record must be able to say guest too");
});
