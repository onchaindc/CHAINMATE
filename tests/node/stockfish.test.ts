/**
 * Regression tests for the Stockfish boot hang.
 *
 * History: UciEngine.start() awaited a reply to "setoption name MultiPV
 * value 3" — a command the UCI protocol NEVER answers. The boot promise
 * suspended forever, the engine never reached ready, and the Stockfish
 * level sat silent for the entire game ("stockfish is broken it isn't
 * playing"). Three guards pin the fix:
 *
 *  1. The boot path never awaits a reply to "setoption" (source guard —
 *     the exact regression).
 *  2. stockfishMove resolves null — never throws — when the engine is
 *     unavailable, so the caller's built-in-engine fallback takes over.
 *  3. requestAiMove at the Stockfish level still returns a legal move in
 *     an environment with no workers and no native engine — the degraded
 *     path that previously hung now plays.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseUciMove, stockfishMove } from "@/lib/stockfish";
import { requestAiMove } from "@/lib/ai-runner";
import { Chess } from "chess.js";

// Read at module load (before any test's before() hook can chdir).
const SOURCE = readFileSync(path.resolve(process.cwd(), "lib", "stockfish.ts"), "utf8");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("the boot path never awaits a reply to setoption (the regression)", () => {
  // The exact hang: `await this.send("setoption …")` waits for a line UCI
  // never sends. start() must fire-and-forget setoption and gate on isready.
  assert.doesNotMatch(SOURCE, /await\s+this\.send\(\s*["'`]setoption/);
  assert.match(SOURCE, /send\(\s*["'`]isready["'`]/);
});

test("every send() is bounded by a timeout", () => {
  // An unbounded wait is the failure mode that froze the game.
  assert.match(SOURCE, /timeoutMs = 10_000/);
  assert.match(SOURCE, /setTimeout\(/);
});

test("stockfishMove resolves null — never throws — when the engine is unavailable", async () => {
  // Node here: no window, no Worker → the engine cannot load. The promise
  // must RESOLVE to null so requestAiMove's fallback runs instead of the
  // rejection escaping uncaught and leaving the bot silent.
  const move = await stockfishMove(START_FEN, { movetime: 100 });
  assert.equal(move, null);
});

test("requestAiMove at the Stockfish level still returns a legal move", async () => {
  // Degraded environment (no native engine, no worker): the built-in engine
  // answers. Before the fix a broken boot left the bot silent forever.
  const chess = new Chess();
  const move = await requestAiMove(chess.fen(), "stockfish", []);
  assert.ok(move, "the degraded path must still produce a move");
  const legal = chess
    .moves({ verbose: true })
    .some((m) => m.from === move.from && m.to === move.to);
  assert.ok(legal, "the move must be legal in the given position");
});

test("parseUciMove validates engine output against the position", () => {
  assert.equal(parseUciMove(START_FEN, "e2e4")?.from, "e2");
  assert.equal(parseUciMove(START_FEN, "e2e4")?.to, "e4");
  assert.equal(parseUciMove(START_FEN, "e2e5"), null, "illegal move rejected");
  assert.equal(parseUciMove(START_FEN, "zzzz"), null, "garbage rejected");
});
