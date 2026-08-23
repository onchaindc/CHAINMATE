/**
 * Integration test for live matchmaking — "the search never pairs anyone".
 *
 * Two players hit Search, both sit at "Searching…" for ninety seconds, and then
 * the panel disappears without a word. Three separate defects could produce
 * exactly that, and all three are pinned here:
 *
 *  1. A rating window read off the *claimer* alone. Only the lexicographically
 *     lower player id ever claims a pairing, so an established claimer looking
 *     at a provisional opponent outside its narrow window refused the game —
 *     and the opponent was structurally forbidden from claiming back. Both
 *     searched forever, however long they waited. See `ratingWindow`.
 *  2. A window that never widened, so no amount of waiting could break out of
 *     (1) and two people alone in the pool could be permanently unpairable.
 *  3. `pollSeek` re-registering the searcher on every poll with a fresh
 *     timestamp, which reset the recorded wait every 2.5 seconds — so even a
 *     widening window would never have widened.
 *
 * These drive the real hosted backend and the real pool: nothing is stubbed.
 * Supabase is unconfigured here, so it is the in-store pool under test; the
 * durable pool's extra machinery (row claiming, withdrawal) needs a database
 * and is covered by reasoning in lib/server/hosted.ts instead.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PlayerStats } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/* Same shape as ratings.test.ts: move cwd before the file store's module ever
   loads, and give the test its own throwaway .data/ root. */
let DATA_ROOT: string;
let hosted: typeof import("@/lib/server/hosted");

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-matchmaking-"));
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

/** A distinct pair of ids per test, so no two tests share a pool entry. */
let seq = 0;
function pair(): [string, string] {
  seq += 1;
  return [`acct_seek_a${seq}`, `acct_seek_b${seq}`];
}

async function account(playerId: string, username: string): Promise<PlayerStats> {
  return hosted.updatePlayerIdentity(playerId, { username, isGuest: false });
}

/* ------------------------------------------------------------------ */
/* The reported bug: two accounts searching must find each other       */
/* ------------------------------------------------------------------ */

test("two players searching at the same time control are paired", async () => {
  const [a, b] = pair();
  await account(a, "Seeker_A");
  await account(b, "Seeker_B");

  const first = await hosted.seekMatch(a, "10 + 0");
  assert.equal(first.status, "waiting", "the first searcher has nobody to pair with yet");

  const second = await hosted.seekMatch(b, "10 + 0");
  assert.equal(second.status, "matched", "the second searcher should pair immediately");
  if (second.status !== "matched") return;

  /* Both sides must land on the SAME game. Two games here is the failure that
     leaves each player alone at their own board. */
  const poll = await hosted.pollSeek(a, "10 + 0");
  assert.equal(poll.status, "matched", "the first searcher never collected the pairing");
  if (poll.status !== "matched") return;
  assert.equal(poll.game.id, second.game.id, "the two players are in different games");

  /* And it is a real, playable, rated game — not a placeholder. */
  assert.equal(poll.game.status, "active");
  assert.equal(poll.game.backend, "hosted");
  assert.deepEqual([poll.game.creator, poll.game.opponent].sort(), [a, b].sort());
  assert.notEqual(poll.game.creator, poll.game.opponent);
});

test("polling while waiting does not drop the searcher out of the pool", async () => {
  const [a, b] = pair();
  await account(a, "Poller_A");
  await account(b, "Poller_B");

  assert.equal((await hosted.seekMatch(a, "10 + 0")).status, "waiting");
  /* The client polls every 2.5s for 90s. Each poll re-registers, and a
     re-registration that clobbered the entry would leave this player waiting
     for a pairing that can never be made. */
  for (let i = 0; i < 4; i++) {
    assert.equal((await hosted.pollSeek(a, "10 + 0")).status, "waiting");
  }

  assert.equal(
    (await hosted.seekMatch(b, "10 + 0")).status,
    "matched",
    "the first searcher fell out of the pool while polling",
  );
});

test("cancelling leaves the pool, so nobody is paired against a ghost", async () => {
  const [a, b] = pair();
  await account(a, "Quitter_A");
  await account(b, "Late_B");

  assert.equal((await hosted.seekMatch(a, "10 + 0")).status, "waiting");
  await hosted.cancelSeek(a);

  assert.equal(
    (await hosted.seekMatch(b, "10 + 0")).status,
    "waiting",
    "paired against a player who had already cancelled",
  );
});

test("a pairing is only offered once", async () => {
  const [a, b] = pair();
  await account(a, "Once_A");
  await account(b, "Once_B");

  await hosted.seekMatch(a, "10 + 0");
  await hosted.seekMatch(b, "10 + 0");
  const collected = await hosted.pollSeek(a, "10 + 0");
  assert.equal(collected.status, "matched");

  /* Hitting Search again must start a fresh search, not re-serve the game just
     collected — that is how a player ends up dumped back into an old board. */
  const again = await hosted.seekMatch(a, "10 + 0");
  assert.equal(again.status, "waiting", "the same pairing was served twice");
});

/* ------------------------------------------------------------------ */
/* The rating window itself — the deadlock, in isolation               */
/* ------------------------------------------------------------------ */

test("the rating window respects BOTH players' confidence", () => {
  const { ratingWindow } = hosted;

  /* Both settled: the narrow window is the point — close games are better. */
  assert.equal(ratingWindow(200, 200, 0), 300);

  /* The deadlock. An established claimer (rd 200) facing a provisional
     opponent (rd 300) used to get 300, refuse a 400-point gap, and hang —
     because that opponent can never claim in return. */
  assert.equal(ratingWindow(200, 300, 0), 500, "an unsettled opponent must widen the window");
  assert.equal(ratingWindow(300, 200, 0), 500, "an unsettled searcher must widen it too");
  assert.ok(ratingWindow(200, 300, 0) >= 400, "the deadlocking gap is still refused");
});

test("the rating window widens with the wait and eventually gives up on rating", () => {
  const { ratingWindow } = hosted;

  assert.equal(ratingWindow(200, 200, 0), 300);
  assert.equal(ratingWindow(200, 200, 19_000), 300, "no widening before 20s");
  assert.equal(ratingWindow(200, 200, 20_000), 550, "widens once the wait is real");
  assert.equal(ratingWindow(300, 300, 20_000), 750, "widening stacks on the provisional base");

  /* The property that makes the deadlock unreachable at any rating spread:
     two people who are both still in the pool after 45s always pair. */
  assert.equal(ratingWindow(200, 200, 45_000), Infinity);
  assert.equal(ratingWindow(10, 10, 90_000), Infinity);

  /* Monotonic — waiting longer can never make you pickier. */
  let previous = 0;
  for (const waited of [0, 19_000, 20_000, 44_000, 45_000]) {
    const window = ratingWindow(200, 200, waited);
    assert.ok(window >= previous, `window shrank at ${waited}ms`);
    previous = window;
  }
});
