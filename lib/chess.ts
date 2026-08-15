import { Chess, type Move, type Square } from "chess.js";
import { START_FEN, type MoveRecord } from "@/lib/types";

/** Wrapper helpers around chess.js. The same validation logic is mirrored
 *  in the GenLayer contract (contracts/chainmate.py). */

export const PIECE_NAMES: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export function newChess(fen: string = START_FEN): Chess {
  return new Chess(fen);
}

export interface MoveOutcome {
  ok: boolean;
  error?: string;
  san?: string;
  fen?: string;
  move?: Move;
}

/** Applies a move to a FEN and returns the resulting state. */
export function applyChessMove(
  fen: string,
  from: string,
  to: string,
  promotion?: string,
): MoveOutcome {
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: from as Square,
      to: to as Square,
      promotion: (promotion || undefined) as "q" | "r" | "b" | "n" | undefined,
    });
    if (!move) {
      return { ok: false, error: "Illegal move" };
    }
    return { ok: true, san: move.san, fen: chess.fen(), move };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Illegal move" };
  }
}

export interface PositionInfo {
  fen: string;
  turn: "w" | "b";
  inCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isDraw: boolean;
  isGameOver: boolean;
}

export function describePosition(fen: string): PositionInfo {
  const chess = new Chess(fen);
  return {
    fen,
    turn: chess.turn(),
    inCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    isGameOver: chess.isGameOver(),
  };
}

export interface Material {
  white: number;
  black: number;
  diff: number;
}

export function materialScore(fen: string): Material {
  const chess = new Chess(fen);
  const board = chess.board();
  let white = 0;
  let black = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type];
      if (cell.color === "w") white += value;
      else black += value;
    }
  }
  return { white, black, diff: white - black };
}

/** "White"/"Black" from a chess.js turn char. */
export function turnLabel(turn: "w" | "b"): "white" | "black" {
  return turn === "w" ? "white" : "black";
}

export function opposite(side: "white" | "black"): "white" | "black" {
  return side === "white" ? "black" : "white";
}

/** Count captures by replaying the recorded move list. */
export function countCaptures(moves: { from: string; to: string }[]): number {
  const chess = new Chess();
  let captures = 0;
  for (const m of moves) {
    try {
      const move = chess.move({ from: m.from as Square, to: m.to as Square });
      if (move.captured) captures += 1;
    } catch {
      break;
    }
  }
  return captures;
}

/** Full move count = number of plies. */
export function totalPly(moves: unknown[]): number {
  return moves.length;
}

/**
 * Replay a recorded move list and return the FEN after `ply` plies
 * (0 = starting position, moves.length = final position). Falls back to the
 * starting position if the record cannot be replayed.
 */
export function fenAfterPly(moves: MoveRecord[], ply: number): string {
  const chess = new Chess(START_FEN);
  const end = Math.max(0, Math.min(ply, moves.length));
  for (let i = 0; i < end; i++) {
    const m = moves[i];
    try {
      const move = chess.move({
        from: m.from as Square,
        to: m.to as Square,
        promotion: (m.promotion || undefined) as "q" | "r" | "b" | "n" | undefined,
      });
      if (!move) return START_FEN;
    } catch {
      return START_FEN;
    }
  }
  return chess.fen();
}
