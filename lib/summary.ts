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
        : game.status === "timeout"
          ? "The game was lost on time before any moves were played."
          : game.status === "aborted"
            ? "The game was aborted before any moves were played."
            : "The game ended before any moves were played.";
  } else if (game.status === "checkmate") {
    finalTactic = `Move ${last.number} — ${last.san} delivers checkmate.`;
  } else if (game.status === "resigned") {
    finalTactic = `Move ${last.number} — ${last.san}, then the game was resigned.`;
  } else if (game.status === "timeout") {
    finalTactic = `Move ${last.number} — ${last.san}, then the clock ran out.`;
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
    timeout: "timeout",
    aborted: "an abort",
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
    if (game.status === "timeout") {
      sentences.push(`${side} won on time — the opponent's clock ran out.`);
    } else {
      sentences.push(`${side} came out on top and claimed the win.`);
    }
  } else if (game.status === "aborted") {
    sentences.push("The match was aborted before it began, so no result was recorded.");
  } else if (game.status === "stalemate") {
    sentences.push("The side to move ran out of legal moves while not in check, so the game ended in stalemate.");
  } else if (game.status === "draw") {
    const agreed = game.commentary.some((c) => /agreed/i.test(c.text));
    sentences.push(
      agreed
        ? "The players agreed to a draw and shared the point."
        : "Neither player had enough material to force a win, so honours were shared.",
    );
  }

  if (totalPly > 0 && (game.status === "resigned" || game.status === "timeout")) {
    const mat = materialScore(game.fen);
    if (mat.diff !== 0) {
      sentences.push(
        `When the game ended, ${mat.diff > 0 ? "White" : "Black"} held a material lead of ${Math.abs(mat.diff)} point${Math.abs(mat.diff) === 1 ? "" : "s"}.`,
      );
    }
  }

  sentences.push("The full move history above can be replayed move by move.");

  return sentences.join(" ");
}

/** The two fields that together describe a game's post-game report. */
type Reported = Pick<GameState, "summary" | "analysis" | "analysisError">;

/**
 * The best available match report: the GenLayer analysis once it has landed,
 * the deterministic fallback until then.
 *
 * Every display site must go through this rather than reading `summary`
 * directly, so that upgrading a game from fallback to real analysis needs no
 * change at the call site.
 */
export function displaySummary(game: Reported): string {
  return game.analysis || game.summary || "";
}

/** True when the report on screen is the deterministic fallback. */
export function isFallbackSummary(game: Reported): boolean {
  return !game.analysis && !!game.summary;
}

/**
 * True when on-chain analysis could still be obtained for this game — it has
 * not been produced, and nothing has yet reported it as impossible. Drives the
 * automatic request the result screen makes when a game ends.
 */
export function analysisPending(game: Reported): boolean {
  return !game.analysis && !game.analysisError;
}

