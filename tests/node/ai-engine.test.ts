/**
 * Regression test for "the computer plays the same moves every game".
 *
 * The engine was fully deterministic: identical evaluation plus chess.js's
 * fixed move order meant the first move found at the best score won every tie
 * forever, so a level replayed the same game from the same position every time.
 * The only variation in the whole engine was `blunderChance`, which means the
 * AI's sole way of differing between games was to make a *mistake*.
 *
 * Variety now comes from picking at random among moves the search ranks within
 * `AiLevel.variety` centipawns of best. The two things that can go wrong with
 * that are pinned below: it has to actually vary, and it must never vary away
 * from a winning move.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";

import { chooseAiMove } from "@/lib/ai-engine";
import { AI_LEVELS } from "@/lib/types";

test("the same position does not always produce the same move", () => {
  const chess = new Chess();
  chess.move("e4");
  const fen = chess.fen();

  // "club" has a low blunder chance, so repeated identical replies here would
  // mean the variety margin is doing nothing rather than that luck intervened.
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const move = chooseAiMove(fen, "club");
    assert.ok(move, "expected a legal reply to 1.e4");
    seen.add(`${move.from}${move.to}`);
  }

  assert.ok(
    seen.size > 1,
    `expected varied replies to 1.e4, always got ${[...seen].join(",")}`,
  );
});

test("every move the AI returns is legal", () => {
  const chess = new Chess();
  chess.move("e4");
  const fen = chess.fen();

  for (const level of AI_LEVELS) {
    const move = chooseAiMove(fen, level.id);
    assert.ok(move, `${level.name} returned no move`);
    const board = new Chess(fen);
    assert.doesNotThrow(
      () => board.move({ from: move.from, to: move.to, promotion: move.promotion }),
      `${level.name} returned illegal move ${move.from}${move.to}`,
    );
  }
});

test("variety never trades away a forced mate", () => {
  // Fool's mate: 1.f3 e5 2.g4 and Black has Qh4#. A mate score dwarfs any
  // variety margin, so the candidate set must collapse to the mating move —
  // this is also a tactical position inside the opening, where the margin is
  // deliberately at its widest.
  const chess = new Chess();
  chess.move("f3");
  chess.move("e5");
  chess.move("g4");
  const fen = chess.fen();

  // "expert" has blunderChance 0, so there is no excuse for missing it.
  const move = chooseAiMove(fen, "expert");
  assert.ok(move, "expected a move in the fool's-mate position");

  const board = new Chess(fen);
  board.move({ from: move.from, to: move.to, promotion: move.promotion });
  assert.ok(
    board.isCheckmate(),
    `expected Qh4# but got ${move.from}${move.to}`,
  );
});

test("a position with one legal move returns that move", () => {
  // 1.e3 f5 2.Qh5+ — Black is in check on the h5-e8 diagonal and the only
  // legal reply in the whole position is blocking with g6.
  const fen = "rnbqkbnr/ppppp1pp/8/5p1Q/8/4P3/PPPP1PPP/RNB1KBNR b KQkq - 1 2";
  const legal = new Chess(fen).moves({ verbose: true });
  assert.equal(legal.length, 1, "test position should have exactly one legal move");

  for (const level of AI_LEVELS) {
    const move = chooseAiMove(fen, level.id);
    assert.ok(move, `${level.name} returned no move`);
    assert.equal(
      `${move.from}${move.to}`,
      `${legal[0].from}${legal[0].to}`,
      `${level.name} must play the only legal move`,
    );
  }
});

test("no move is offered when the game is already over", () => {
  // Checkmated position — the caller relies on null to stop asking.
  const chess = new Chess();
  chess.move("f3");
  chess.move("e5");
  chess.move("g4");
  chess.move("Qh4");
  assert.ok(chess.isCheckmate(), "position should be checkmate");
  assert.equal(chooseAiMove(chess.fen(), "expert"), null);
});
