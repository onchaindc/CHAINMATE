/**
 * Integration test for the hosted post-game analysis path.
 *
 * This exists because of a review finding: the default hosted end-game flow
 * stored a rule-based summary the instant a game finished, and
 * `summarizeHostedGame` returned early on `if (game.summary)` — so
 * `analyzeGameOnChain()` was unreachable in the normal flow. The tests below
 * pin the fix: a game that ends the ordinary way (real moves, real checkmate,
 * real resignation) still reaches the analyzer, and the deterministic fallback
 * no longer masquerades as completed analysis.
 *
 * "Integration" here means the real hosted backend, real game logic, real
 * storage and the real end-game paths. The only stub is the GenLayer testnet
 * call itself, injected through the `GameAnalyzer` seam — a network round trip
 * to a live chain is not something a test can assert on. The last test closes
 * that loop by checking the production binding really points at
 * `analyzeGameOnChain`, so these tests cannot pass while production is wired
 * to something else.
 *
 * Run: npm test
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AnalyzableGame, GameAnalyzer } from "@/lib/server/genlayer";
import type { GameState } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/* The file store resolves `.data/` off process.cwd() when its module first
   loads, so the working directory has to move before anything imports it —
   hence the dynamic import in before(). Tests must never write to the repo's
   real .data/. */
let DATA_ROOT: string;
let hosted: typeof import("@/lib/server/hosted");

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-test-"));
  process.chdir(DATA_ROOT);
  /* No KV, no Supabase: the file store under DATA_ROOT is the whole world. */
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

/** A GameAnalyzer that records every call instead of touching a chain. */
function recordingAnalyzer(
  opts: { available?: boolean; text?: string; fail?: string } = {},
) {
  const calls: AnalyzableGame[] = [];
  const analyzer: GameAnalyzer = {
    available: () => opts.available !== false,
    analyze: async (game) => {
      calls.push(game);
      if (opts.fail) throw new Error(opts.fail);
      return (
        opts.text ??
        "GenLayer validators agree: Black punished the weakening kingside pawn " +
          "moves immediately, and the queen sortie to h4 was already decisive."
      );
    },
  };
  return { analyzer, calls };
}

const WHITE = "acct_white_player";
const BLACK = "acct_black_player";

/** Two distinct human players, sat down at a fresh hosted game. */
async function startGame(): Promise<GameState> {
  const game = await hosted.createHostedGame(WHITE, { visibility: "private" });
  return hosted.joinHostedGame(game.id, BLACK);
}

/** Play a list of [from, to] pairs, alternating White and Black. */
async function play(id: string, moves: [string, string][]): Promise<GameState> {
  let state: GameState | null = null;
  for (const [i, [from, to]] of moves.entries()) {
    state = await hosted.submitHostedMove(id, i % 2 === 0 ? WHITE : BLACK, from, to);
  }
  return state!;
}

/* Fool's mate: 1. f3 e5 2. g4 Qh4# — the shortest real checkmate, so the
   end-game path under test is the ordinary "a move ended the game" one. Black
   (the joiner) delivers it. */
const FOOLS_MATE: [string, string][] = [
  ["f2", "f3"],
  ["e7", "e5"],
  ["g2", "g4"],
  ["d8", "h4"],
];

beforeEach(() => {
  /* Storage is per-game-id, and every test starts a new game, so there is no
     shared state to reset. Kept as a marker: if that ever stops being true,
     this is where the store gets cleared. */
});

/* ------------------------------------------------------------------ */
/* The review finding                                                  */
/* ------------------------------------------------------------------ */

test("a normal hosted game that ends in checkmate reaches analyzeGameOnChain()", async () => {
  const game = await startGame();
  const finished = await play(game.id, FOOLS_MATE);

  /* The end-game path did its job: the game is over and the deterministic
     report is already in place. This is precisely the state that used to make
     the analyzer unreachable. */
  assert.equal(finished.status, "checkmate");
  assert.ok(finished.summary.length > 0, "expected the rule-based fallback to be stored");
  assert.equal(finished.analysis, undefined, "no analysis should exist yet");

  const { analyzer, calls } = recordingAnalyzer();
  const analysed = await hosted.summarizeHostedGame(game.id, analyzer);

  assert.equal(calls.length, 1, "analyzeGameOnChain() was never reached");
  assert.ok(analysed.analysis, "analysis text was not stored");
  assert.match(analysed.analysis!, /GenLayer validators agree/);

  /* The analyzer received the real game, not an empty shell. Black — the
     joiner — is the one who mates in this line. */
  assert.equal(calls[0].status, "checkmate");
  assert.equal(calls[0].winner, BLACK);
  assert.deepEqual(
    calls[0].moves.map((m) => m.san),
    ["f3", "e5", "g4", "Qh4#"],
  );
});

test("a resigned game also reaches the analyzer", async () => {
  const game = await startGame();
  await play(game.id, [["e2", "e4"], ["e7", "e5"]]);
  const finished = await hosted.resignHostedGame(game.id, BLACK);

  assert.equal(finished.status, "resigned");
  assert.ok(finished.summary.length > 0);

  const { analyzer, calls } = recordingAnalyzer();
  await hosted.summarizeHostedGame(game.id, analyzer);
  assert.equal(calls.length, 1, "a resignation must not skip analysis");
});

test("the stored fallback does not count as completed analysis", async () => {
  const game = await startGame();
  const finished = await play(game.id, FOOLS_MATE);

  const { isFallbackSummary, analysisPending } = await import("@/lib/summary");
  assert.ok(isFallbackSummary(finished), "a fallback report must be identifiable as one");
  assert.ok(analysisPending(finished), "analysis must still be considered outstanding");
});

/* ------------------------------------------------------------------ */
/* Idempotence and failure handling                                    */
/* ------------------------------------------------------------------ */

test("completed analysis is never regenerated", async () => {
  const game = await startGame();
  await play(game.id, FOOLS_MATE);

  const first = recordingAnalyzer({ text: "First analysis, from the chain." });
  await hosted.summarizeHostedGame(game.id, first.analyzer);
  assert.equal(first.calls.length, 1);

  /* Asking again must not deploy a second contract. */
  const second = recordingAnalyzer({ text: "Should never be produced." });
  const again = await hosted.summarizeHostedGame(game.id, second.analyzer);
  assert.equal(second.calls.length, 0, "analysis was regenerated");
  assert.equal(again.analysis, "First analysis, from the chain.");
});

test("a failed analysis keeps the fallback, records why, and stays retryable", async () => {
  const game = await startGame();
  await play(game.id, FOOLS_MATE);

  const failing = recordingAnalyzer({ fail: "validator consensus timed out" });
  const failed = await hosted.summarizeHostedGame(game.id, failing.analyzer);

  assert.equal(failing.calls.length, 1);
  assert.equal(failed.analysis, undefined);
  assert.match(failed.analysisError!, /consensus timed out/);
  assert.ok(failed.summary.length > 0, "the game result must still be readable");

  /* An error is not a terminal state — a later attempt must be allowed. */
  const retry = recordingAnalyzer({ text: "Second attempt succeeded." });
  const fixed = await hosted.summarizeHostedGame(game.id, retry.analyzer);
  assert.equal(retry.calls.length, 1, "a failed analysis must be retryable");
  assert.equal(fixed.analysis, "Second attempt succeeded.");
  assert.equal(fixed.analysisError, undefined, "the stale error must be cleared");
});

test("without signing keys the game is marked unavailable, not silently fallen back", async () => {
  const game = await startGame();
  await play(game.id, FOOLS_MATE);

  const { analyzer, calls } = recordingAnalyzer({ available: false });
  const result = await hosted.summarizeHostedGame(game.id, analyzer);

  assert.equal(calls.length, 0, "no analysis should be attempted without keys");
  assert.equal(result.analysis, undefined);
  assert.match(result.analysisError!, /GenLayer signing key/);
  assert.ok(result.summary.length > 0);
});

test("concurrent requests share one analysis run", async () => {
  const game = await startGame();
  await play(game.id, FOOLS_MATE);

  const { analyzer, calls } = recordingAnalyzer();
  const [a, b, c] = await Promise.all([
    hosted.summarizeHostedGame(game.id, analyzer),
    hosted.summarizeHostedGame(game.id, analyzer),
    hosted.summarizeHostedGame(game.id, analyzer),
  ]);

  assert.equal(calls.length, 1, "both players' result screens deployed a contract each");
  assert.equal(a.analysis, b.analysis);
  assert.equal(b.analysis, c.analysis);
});

test("an unfinished game is refused", async () => {
  const game = await startGame();
  await play(game.id, [["e2", "e4"]]);

  const { analyzer, calls } = recordingAnalyzer();
  await assert.rejects(
    () => hosted.summarizeHostedGame(game.id, analyzer),
    /still in progress/,
  );
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Server-side auto-trigger                                            */
/* ------------------------------------------------------------------ */

test("the game-end path auto-requests analysis server-side when keys are configured", async () => {
  /* The steward requirement: a completed game must create a GenLayer request
     without any browser interaction. The auto-trigger fires inside the
     game-end path (checkmate / resign / timeout / draw) the moment the game
     finishes, but only when signing keys are actually configured. With a
     (fake) key set, the real analyzer is invoked and fails locally — which
     still proves the request was created: the game records why. */
  process.env.GENLAYER_PRIVATE_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  try {
    const game = await startGame();
    await play(game.id, FOOLS_MATE);

    // Give the fire-and-forget trigger a moment to settle locally.
    await new Promise((r) => setTimeout(r, 500));
    const settled = await hosted.getHostedGame(game.id);

    // The trigger ran: it attempted the (real) analyzer and recorded the
    // failure rather than silently doing nothing.
    assert.ok(
      settled!.analysisError,
      "the game-end path must have auto-requested analysis (got: " +
        JSON.stringify(settled!.analysisError ?? null) +
        ")",
    );
    assert.equal(settled!.analysis, undefined);
    assert.ok(settled!.summary.length > 0, "the fallback report must still be present");
  } finally {
    delete process.env.GENLAYER_PRIVATE_KEY;
  }
});

test("without keys the game-end path does not attempt analysis", async () => {
  delete process.env.GENLAYER_PRIVATE_KEY;
  const game = await startGame();
  const finished = await play(game.id, FOOLS_MATE);

  await new Promise((r) => setTimeout(r, 100));
  const settled = await hosted.getHostedGame(game.id);
  assert.equal(settled!.analysis, undefined);
  assert.equal(settled!.analysisError, undefined, "no keys means no auto-request");
});

/* ------------------------------------------------------------------ */
/* Production wiring                                                   */
/* ------------------------------------------------------------------ */

test("the default analyzer is the real on-chain implementation", async () => {
  const genlayer = await import("@/lib/server/genlayer");

  /* Without this, every test above could pass while production analysed
     nothing: the injected stub would be the only implementation ever used. */
  assert.equal(
    genlayer.genlayerAnalyzer.analyze,
    genlayer.analyzeGameOnChain,
    "the production analyzer must call analyzeGameOnChain",
  );
  assert.equal(
    genlayer.genlayerAnalyzer.available,
    genlayer.genlayerKeysAvailable,
    "availability must be decided by the real key check",
  );

  /* And summarizeHostedGame must default to it, so the API route needs no
     knowledge of the seam. */
  assert.equal(hosted.summarizeHostedGame.length, 1, "the analyzer must be an optional parameter");
});
