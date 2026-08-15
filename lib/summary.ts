import { countCaptures, materialScore } from "@/lib/chess";
import type { GameState } from "@/lib/types";
import { isGameOver } from "@/lib/types";

/**
 * Deterministic post-game analysis. Used by the local backend and as the
 * fallback when the on-chain LLM summary isn't available.
 */
export interface KeyMoments {
  opening: string;
  turningPoint: string;
  finalTactic: string;
}

/**
 * Derive the key moments of a finished game from its move record — the
 * opening, the first decisive moment, and how it ended. Pure data, used by
 * the game-result report.
 */
export function keyMoments(game: GameState): KeyMoments {
  const moves = game.moves;
  const opening = moves.slice(0, 4).map((m) => m.san).join(" ") || "—";

  const decisiveIdx = moves.findIndex(
    (m) => m.san.includes("x") || m.san.includes("+") || m.san.includes("#"),
  );
  let turningPoint: string;
  if (decisiveIdx === -1) {
    turningPoint = "A quiet positional game — no captures or checks until the end.";
  } else {
    const m = moves[decisiveIdx];
    const kind = m.san.includes("#")
      ? "checkmate"
      : m.san.includes("+")
        ? "check"
        : "capture";
    turningPoint = `Move ${m.number} — ${m.san} (${kind}) shifted the balance.`;
  }

  const last = moves[moves.length - 1];
  let finalTactic: string;
  if (!last) {
    finalTactic =
      game.status === "resigned"
        ? "The game was resigned before any moves were played."
        : "The game ended before any moves were played.";
  } else if (game.status === "checkmate") {
    finalTactic = `Move ${last.number} — ${last.san} delivers checkmate.`;
  } else if (game.status === "resigned") {
    finalTactic = `Move ${last.number} — ${last.san}, then the game was resigned.`;
  } else if (game.status === "stalemate") {
    finalTactic = `Move ${last.number} — ${last.san} left no legal moves. Stalemate.`;
  } else {
    finalTactic = `Move ${last.number} — ${last.san} ended the game.`;
  }

  return { opening, turningPoint, finalTactic };
}

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
