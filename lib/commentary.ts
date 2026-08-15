import type { Move } from "chess.js";
import { materialScore, PIECE_NAMES, turnLabel } from "@/lib/chess";
import type { PlayerSide } from "@/lib/types";

/**
 * Rule-based move commentary. Instant, deterministic and works with zero
 * external services — the fallback whenever no LLM API key is configured.
 */

const CENTER = new Set(["d4", "e4", "d5", "e5"]);

const OPENING_HINTS = [
  "A solid developing move, fighting for space in the center.",
  "Developing a piece toward the center of the board.",
  "Improving piece activity while keeping the king safe.",
  "Gaining control of key central squares.",
];

export interface CommentaryContext {
  side: PlayerSide;
  moveNumber: number; // ply number (1-based)
  move: Move;
  fenAfter: string;
}

export function generateMoveCommentary(ctx: CommentaryContext): string {
  const { side, moveNumber, move, fenAfter } = ctx;
  const mover = side === "white" ? "White" : "Black";
  const pieceName = PIECE_NAMES[move.piece] ?? "piece";
  const pieceUpper = move.piece.toUpperCase();
  const parts: string[] = [];

  if (move.san === "O-O" || move.san === "O-O-O") {
    parts.push(
      `${mover} castles ${move.san === "O-O" ? "kingside" : "queenside"}, tucking the king into safety behind a wall of pawns.`,
    );
  } else if (move.promotion) {
    parts.push(
      `${mover} plays ${move.san} — a pawn reaches the eighth rank and promotes to a ${PIECE_NAMES[move.promotion]}!`,
    );
  } else if (move.captured) {
    const victim = PIECE_NAMES[move.captured] ?? "piece";
    const epNote = move.flags.includes("e") ? " en passant" : "";
    parts.push(
      `${mover}'s ${pieceName} captures${epNote} ${mover === "White" ? "Black" : "White"}'s ${victim} on ${move.to} with ${move.san}.`,
    );
  } else {
    const to = move.to;
    if (to === "d4" || to === "e4" || to === "d5" || to === "e5") {
      parts.push(`${mover} stakes a claim to the center with ${move.san}.`);
    } else if ((move.piece === "n" || move.piece === "b") && moveNumber <= 8) {
      parts.push(`${mover} plays ${move.san}. ${OPENING_HINTS[(moveNumber + move.to.charCodeAt(0)) % OPENING_HINTS.length]}`);
    } else if (move.piece === "q" && moveNumber <= 10) {
      parts.push(`${mover} brings the queen out early with ${move.san}.`);
    } else if (move.piece === "p" && (move.to[1] === "4" || move.to[1] === "5")) {
      parts.push(`${mover} pushes a pawn with ${move.san}, grabbing space.`);
    } else {
      parts.push(`${mover} plays ${move.san}.`);
    }
  }

  // Material angle
  if (move.captured) {
    const mat = materialScore(fenAfter);
    const lead = Math.abs(mat.diff);
    if (lead > 0 && mat.diff !== 0) {
      parts.push(
        `${mover === "White" ? "White" : "Black"} is now up material (${lead} point${lead === 1 ? "" : "s"}).`,
      );
    }
  }

  // Check detection
  if (move.san.endsWith("#")) {
    parts.push(`${move.san} is checkmate — the game is decided!`);
  } else if (move.san.endsWith("+")) {
    parts.push(`${move.san} puts the opponent in check!`);
  }

  return parts.join(" ");
}

/** Fallback commentary for events like resignations. */
export function eventCommentary(side: PlayerSide, event: string): string {
  const mover = side === "white" ? "White" : "Black";
  switch (event) {
    case "resign":
      return `${mover} resigned the game.`;
    case "stalemate":
      return "Stalemate — the side to move has no legal moves but is not in check.";
    case "draw":
      return "The game is drawn by insufficient material.";
    default:
      return `${mover} made a move.`;
  }
}

export { turnLabel };
