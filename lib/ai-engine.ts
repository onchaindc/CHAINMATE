import { Chess, type Move } from "chess.js";
import type { AiDifficulty } from "@/lib/types";

/**
 * Built-in chess opponent for single-player games. Pure client-side minimax
 * with alpha-beta pruning and piece-square evaluation — no network, no LLM,
 * no keys. The AI always plays Black.
 */

const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

const MATE = 1_000_000;

// Classic "simplified evaluation function" tables, from White's perspective
// with row 0 = rank 8 (a8..h8) down to rank 1.
const PAWN_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];

const KNIGHT_PST = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];

const BISHOP_PST = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];

const ROOK_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];

const QUEEN_PST = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];

const KING_MIDDLE_PST = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];

const KING_ENDGAME_PST = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

/** Rough material count — used to pick the endgame king table. */
function materialTotal(chess: Chess): number {
  let total = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type !== "k") total += PIECE_VALUES[cell.type];
    }
  }
  return total;
}

function evaluate(chess: Chess): number {
  const board = chess.board();
  const endgame = materialTotal(chess) <= 1300;
  let score = 0;
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank][file];
      if (!piece) continue;
      const idx = rank * 8 + file;
      const table =
        piece.type === "p"
          ? PAWN_PST
          : piece.type === "n"
            ? KNIGHT_PST
            : piece.type === "b"
              ? BISHOP_PST
              : piece.type === "r"
                ? ROOK_PST
                : piece.type === "q"
                  ? QUEEN_PST
                  : endgame
                    ? KING_ENDGAME_PST
                    : KING_MIDDLE_PST;
      const pst = piece.color === "w" ? table[idx] : table[(7 - rank) * 8 + file];
      score += piece.color === "w" ? PIECE_VALUES[piece.type] + pst : -(PIECE_VALUES[piece.type] + pst);
    }
  }
  // small tempo bonus for the side to move
  score += chess.turn() === "w" ? 10 : -10;
  return score;
}

/** MVV-LVA move ordering: captures and promotions first for better pruning. */
function orderedMoves(chess: Chess): Move[] {
  const moves = chess.moves({ verbose: true });
  return moves.sort((a, b) => {
    const score = (m: Move) => {
      let s = 0;
      if (m.captured) s += 10 * PIECE_VALUES[m.captured] - PIECE_VALUES[m.piece];
      if (m.promotion) s += 900;
      return s;
    };
    return score(b) - score(a);
  });
}

function minimax(chess: Chess, depth: number, alpha: number, beta: number, maximizing: boolean): number {
  if (chess.isCheckmate()) return maximizing ? -MATE + depth : MATE - depth;
  if (chess.isDraw() || chess.isStalemate() || chess.isThreefoldRepetition()) return 0;
  if (depth === 0) return evaluate(chess);

  const moves = orderedMoves(chess);
  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      const score = minimax(chess, depth - 1, alpha, beta, false);
      chess.undo();
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    chess.move(m);
    const score = minimax(chess, depth - 1, alpha, beta, true);
    chess.undo();
    if (score < best) best = score;
    if (best < beta) beta = best;
    if (alpha >= beta) break;
  }
  return best;
}

export interface AiMove {
  from: string;
  to: string;
  promotion?: string;
}

/**
 * Pick the AI's move for the given position. Returns null when the side to
 * move has no legal moves (checkmate / stalemate already handled by caller).
 */
export function chooseAiMove(fen: string, difficulty: AiDifficulty = "casual"): AiMove | null {
  const chess = new Chess(fen);
  const moves = orderedMoves(chess);
  if (moves.length === 0) return null;

  const depth = difficulty === "competitive" ? 3 : 2;
  const maximizing = chess.turn() === "w";

  let bestMove: Move | null = null;
  let bestScore = maximizing ? -Infinity : Infinity;
  let alpha = -Infinity;
  let beta = Infinity;

  for (const m of moves) {
    chess.move(m);
    const score = minimax(chess, depth - 1, alpha, beta, !maximizing);
    chess.undo();
    if (maximizing ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestMove = m;
    }
    if (maximizing && bestScore > alpha) alpha = bestScore;
    if (!maximizing && bestScore < beta) beta = bestScore;
  }

  if (!bestMove) return null;
  return { from: bestMove.from, to: bestMove.to, promotion: bestMove.promotion };
}
