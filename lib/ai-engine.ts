import { Chess, type Move } from "chess.js";
import { aiLevelFor, type AiDifficulty } from "@/lib/types";

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

/**
 * Static evaluation, from White's perspective, in centipawns.
 *
 * Deliberately a **single** pass over the board. Picking the king table needs
 * the material total, which used to mean a second full walk (`materialTotal`)
 * for every leaf — 128 square visits per evaluation instead of 64, on the
 * hottest path in the engine. The kings are set aside during the one walk and
 * scored once the total is known, which is the same number the two-pass version
 * produced.
 */
function evaluate(chess: Chess): number {
  const board = chess.board();
  let score = 0;
  let material = 0;
  // Mirrored already for Black, so the king table can be applied straight off.
  let whiteKingIdx = -1;
  let blackKingIdx = -1;

  for (let rank = 0; rank < 8; rank++) {
    const row = board[rank];
    for (let file = 0; file < 8; file++) {
      const piece = row[file];
      if (!piece) continue;
      const idx = rank * 8 + file;
      if (piece.type === "k") {
        if (piece.color === "w") whiteKingIdx = idx;
        else blackKingIdx = (7 - rank) * 8 + file;
        continue;
      }
      const value = PIECE_VALUES[piece.type];
      material += value;
      const table =
        piece.type === "p"
          ? PAWN_PST
          : piece.type === "n"
            ? KNIGHT_PST
            : piece.type === "b"
              ? BISHOP_PST
              : piece.type === "r"
                ? ROOK_PST
                : QUEEN_PST;
      const pst = piece.color === "w" ? table[idx] : table[(7 - rank) * 8 + file];
      score += piece.color === "w" ? value + pst : -(value + pst);
    }
  }

  // Kings carry no material value — only their placement bonus counts.
  const kingTable = material <= 1300 ? KING_ENDGAME_PST : KING_MIDDLE_PST;
  if (whiteKingIdx >= 0) score += kingTable[whiteKingIdx];
  if (blackKingIdx >= 0) score -= kingTable[blackKingIdx];

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

/**
 * How many plies count as "the opening" for variety purposes, and the margin
 * used there.
 *
 * The strong levels keep a deliberately tight margin so they never trade real
 * advantage for variety — but measured at depth 3 the gaps between sound opening
 * replies are 45-60cp, far wider than that margin, so the top level answered
 * 1.e4 with Nf6 and 1.d4 with Nc6 in every single game. A crude
 * material-plus-placement evaluation simply cannot tell main-line openings
 * apart, and a 60cp "loss" it reports between Nf6, e5, d5 and Nc6 is noise
 * rather than chess. Widening the margin for the opening only buys the variety
 * where the evaluation is least meaningful, and leaves the middlegame — where
 * 60cp is a real pawn-and-a-half of tactics — on the tight margin.
 *
 * The search still ranks every candidate, so this can only ever pick a move the
 * engine already considers near-best; it is not a random opening.
 */
const OPENING_PLIES = 8;
const OPENING_VARIETY = 60;

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

  const level = aiLevelFor(difficulty);
  // Weaker levels sometimes play a random legal move — the classic way lower
  // ratings hang pieces — while stronger levels always take the best line.
  if (level.blunderChance > 0 && Math.random() < level.blunderChance) {
    const random = moves[Math.floor(Math.random() * moves.length)];
    return { from: random.from, to: random.to, promotion: random.promotion };
  }

  const depth = level.depth;
  const maximizing = chess.turn() === "w";
  // Games are usually loaded from a FEN, so history() is empty — the move
  // number in the FEN itself is what tells us how far in we are.
  const plies = (chess.moveNumber() - 1) * 2 + (chess.turn() === "b" ? 1 : 0);

  /**
   * Root search, widened by exactly the variety margin — no more.
   *
   * Plain alpha-beta at the root is what made every game identical: once alpha
   * reaches the best score, a later move that is in fact just as good gets cut
   * off and returns a fail-low *upper bound* instead of its real score, so it
   * can never compare equal. The first move at the best score therefore won
   * every tie forever, because both the evaluation and chess.js's move order
   * are deterministic.
   *
   * Choosing fairly among near-equals only needs exact scores for moves inside
   * the margin, so the bound trails the best score by `variety` instead of
   * matching it. Children are searched with a one-sided window (the other side
   * is infinite), so the only possible inexactness is a cutoff against that
   * bound: a move that beats the bound it was searched with cannot have been
   * cut off and its score is exact, while one that does not is provably outside
   * the margin and is dropped. Full-window scoring of every root move would
   * also work and is what the first attempt did — it cost ~5x the time.
   */
  const variety = plies < OPENING_PLIES ? Math.max(level.variety, OPENING_VARIETY) : level.variety;

  /**
   * Pass 1 — an ordinary, fully-pruned alpha-beta root search for the best move
   * and its **exact** score. Identical to what the engine always did, and the
   * reason every game was the same: once alpha reaches the best score a later
   * move that is in fact just as good gets cut off and returns a fail-low upper
   * bound rather than its real score, so it can never compare equal. With a
   * deterministic evaluation and chess.js's fixed move order, the first move at
   * the best score therefore won every tie forever.
   */
  let bestScore = maximizing ? -Infinity : Infinity;  let bestMove: Move = moves[0];
  let alpha = -Infinity;
  let beta = Infinity;

  for (const move of moves) {
    chess.move(move);
    const score = minimax(chess, depth - 1, alpha, beta, !maximizing);
    chess.undo();
    if (maximizing ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestMove = move;
    }
    if (maximizing) {
      if (bestScore > alpha) alpha = bestScore;
    } else if (bestScore < beta) beta = bestScore;
  }

  /**
   * Pass 2 — which of the other moves are within `variety` centipawns of best?
   *
   * Answering that needs only a yes/no, not a score, so each move gets a
   * **null-window** search: a window one centipawn wide straddling the
   * threshold. That is the cheapest search shape there is — every node has an
   * immediate cutoff available — which is what makes asking N extra questions
   * affordable. Re-scoring each root move with a wide window would answer the
   * same question and was the first attempt here; it cost several times this.
   *
   * A mate score dwarfs any margin, so a forced win is never traded away for
   * variety — the candidate set collapses to the mating moves on its own.
   */
  const threshold = maximizing ? bestScore - variety : bestScore + variety;
  const candidates: Move[] = [bestMove];

  if (variety > 0) {
    for (const move of moves) {
      if (move === bestMove) continue;
      chess.move(move);
      // Maximizing: does this move reach the threshold (fail high)? Minimizing:
      // does it stay at or under it (fail low)?
      const score = maximizing
        ? minimax(chess, depth - 1, threshold - 1, threshold, false)
        : minimax(chess, depth - 1, threshold, threshold + 1, true);
      chess.undo();
      if (maximizing ? score >= threshold : score <= threshold) candidates.push(move);
    }
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { from: pick.from, to: pick.to, promotion: pick.promotion };
}

