import { drawReason, opposite } from "@/lib/chess";
import type { GameState, PlayerSide } from "@/lib/types";

/**
 * How a finished game ended, described once and shared by everything that
 * reports a result: the end-of-match modal, the persistent result banner on the
 * game page, and the completed-game rows in history. Keeping it in one place is
 * what stops the modal and the page from disagreeing about the same game.
 */
export interface GameResultInfo {
  /** From the viewer's point of view: "You won" / "Draw" / "White wins". */
  verdict: string;
  /** Short qualifier, as a suffix to the verdict: "by Checkmate". */
  reason: string;
  /** A full sentence naming the sides and the move it happened on. */
  detail: string;
  winnerSide: PlayerSide | null;
  isDraw: boolean;
  /** The viewer won / lost (both false when spectating or on a draw). */
  won: boolean;
  lost: boolean;
}

const sideName = (side: PlayerSide) => (side === "white" ? "White" : "Black");

/** Draws by agreement leave a real record in the commentary. */
function drawnByAgreement(game: GameState): boolean {
  return game.commentary.some((c) => /agreed/i.test(c.text));
}

/**
 * Which colour won, from the winner id. Guards against the empty-string trap:
 * an aborted game has `winner: ""` and, while it was still waiting, also
 * `opponent: ""` — comparing them directly would crown Black.
 */
export function winnerSideOf(game: GameState): PlayerSide | null {
  if (!game.winner) return null;
  if (game.winner === game.creator) return "white";
  if (game.winner === game.opponent) return "black";
  return null;
}

export function describeResult(
  game: GameState,
  mySide: PlayerSide | null,
): GameResultInfo {
  const winnerSide = winnerSideOf(game);
  const loserSide = winnerSide ? opposite(winnerSide) : null;
  const aborted = game.status === "aborted";
  const isDraw = !aborted && winnerSide === null;

  const verdict = aborted
    ? "Aborted"
    : isDraw
      ? "Draw"
      : mySide
        ? winnerSide === mySide
          ? "You won"
          : "You lost"
        : winnerSide === "white"
          ? "White wins"
          : "Black wins";

  // Full moves, not plies — "move 24" is what a player counts.
  const fullMoves = Math.ceil(game.moves.length / 2);
  const onMove = game.moves.length > 0 ? ` on move ${fullMoves}` : "";

  let reason: string;
  let detail: string;
  switch (game.status) {
    case "checkmate":
      reason = "by Checkmate";
      detail = winnerSide
        ? `${sideName(winnerSide)} delivered checkmate${onMove}.`
        : `The game ended in checkmate${onMove}.`;
      break;
    case "resigned":
      reason = "by Resignation";
      detail =
        loserSide && winnerSide
          ? `${sideName(loserSide)} resigned${onMove} — ${sideName(winnerSide)} wins.`
          : `A player resigned${onMove}.`;
      break;
    case "timeout":
      reason = "on Timeout";
      detail =
        loserSide && winnerSide
          ? `${sideName(loserSide)} ran out of time${onMove} — ${sideName(winnerSide)} wins.`
          : `A player ran out of time${onMove}.`;
      break;
    case "stalemate":
      reason = "by Stalemate";
      detail = `Stalemate${onMove} — the side to move has no legal move, so the game is drawn.`;
      break;
    case "draw": {
      if (drawnByAgreement(game)) {
        reason = "by Agreement";
        detail = `The players agreed to a draw${onMove}.`;
      } else {
        const how = drawReason(game.fen);
        reason = how ? `by ${how}` : "by Draw";
        detail = how ? `Drawn by ${how}${onMove}.` : `The game was drawn${onMove}.`;
      }
      break;
    }
    case "aborted":
      reason = "before any moves";
      detail = "Aborted before any moves were played — nobody's rating changed.";
      break;
    default:
      reason = game.status;
      detail = "This game is still in progress.";
      break;
  }

  return {
    verdict,
    reason,
    detail,
    winnerSide,
    isDraw,
    won: !isDraw && !aborted && mySide !== null && mySide === winnerSide,
    lost: !isDraw && !aborted && mySide !== null && winnerSide !== null && mySide !== winnerSide,
  };
}
