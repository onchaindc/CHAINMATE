import { countCaptures, materialScore } from "@/lib/chess";
import type { GameState } from "@/lib/types";
import { isGameOver } from "@/lib/types";

/**
 * Deterministic post-game analysis. Used by the local backend and as the
 * fallback when the on-chain LLM summary isn't available.
 */
export function buildRuleSummary(game: GameState): string {
  const totalPly = game.moves.length;
  const captures = countCaptures(game.moves);
  const resultLabel: Record<string, string> = {
    checkmate: "checkmate",
    stalemate: "stalemate",
    draw: "a draw",
    resigned: "a resignation",
  };
  const label = isGameOver(game.status) ? (resultLabel[game.status] ?? game.status) : "the game";
  const sentences: string[] = [];

  if (totalPly === 0) {
    sentences.push(`The game ended by ${label} without a single move being played.`);
  } else {
    sentences.push(`The game lasted ${totalPly} move${totalPly === 1 ? "" : "s"} and ended by ${label}.`);
  }

  if (captures > 0) {
    sentences.push(`There were ${captures} capture${captures === 1 ? "" : "s"} over the course of the game.`);
  }

  if (game.winner) {
    const side = game.winner === game.creator ? "White" : "Black";
    sentences.push(`${side} came out on top and claimed the win.`);
  } else if (game.status === "stalemate") {
    sentences.push("The side to move ran out of legal moves while not in check, so the game ended in stalemate.");
  } else if (game.status === "draw") {
    sentences.push("Neither player had enough material to force a win, so honours were shared.");
  }

  if (totalPly > 0) {
    const mat = materialScore(game.fen);
    if (mat.diff !== 0 && game.status === "resigned") {
      sentences.push(
        `At resignation, ${mat.diff > 0 ? "White" : "Black"} held a material lead of ${Math.abs(mat.diff)} point${Math.abs(mat.diff) === 1 ? "" : "s"}.`,
      );
    }
  }

  sentences.push("The full move history above can be replayed move by move.");

  return sentences.join(" ");
}
