import { Chess, type Move } from "chess.js";
import { aiLevelFor, type AiDifficulty } from "@/lib/types";

/**
 * Built-in chess opponent for single-player games. Pure client-side search —
 * no network, no LLM, no keys. The AI always plays Black.
 *
 * The 2026 rebuild, in order of playing strength:
 *
 *  1. **Iterative deepening with a time budget.** Every level gets a think
 *     time; the search deepens 1, 2, 3… plies until the budget is spent and
 *     plays the best move from the last *completed* depth. Depth is no longer
 *     a fixed number that gets slow in crowded positions and shallow in sharp
 *     ones — the same level looks deeper where the position demands it, and
 *     the hard levels can be trusted with a clock.
 *
 *  2. **Quiescence search.** Plain fixed-depth alpha-beta stops at a horizon:
 *     if the last ply ends just as a capture becomes available, the engine
 *     scores the position before the capture and walks into exchanges it
 *     loses ("horizon effect"). Quiescence keeps resolving captures past the
 *     horizon until the position is quiet, so the scores it reasons with are
 *     ones it can trust. This is the biggest tactical jump available at this
 *     engine size.
 *
 *  3. **Check extensions.** A checking move is searched one ply deeper, so
 *     mating lines that cross the horizon are now seen.
 *
 *  4. **A transposition table** — the same position reached by different move
 *     orders is searched once, and the table's best move is tried first at
 *     every node, which is what makes iterative deepening affordable.
 *
 *  5. **A real opening book** for the top levels: main-line repertoire with
 *     random selection per game, so no two games start alike and the engine
 *     stops "answering 1.e4 with Nf6 and 1.d4 with Nc6 with equal confidence".
 *
 *  6. **A harsher evaluation.** Bishop pair, doubled/isolated pawn penalties,
 *     rook open-file bonuses, mobility. None of it fancy; all of it chess.
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

/* ------------------------------------------------------------------ */
/* Evaluation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Static evaluation, from White's perspective, in centipawns.
 *
 * One pass over the board collects: material + placement, per-file pawn
 * counts (doubled / isolated penalties), the bishop pair, rook open files.
 * The kings are set aside during the walk and scored once the material total
 * is known (which king table to use depends on it).
 */
function evaluate(chess: Chess): number {
  const board = chess.board();
  let score = 0;
  let material = 0;
  let whiteKingIdx = -1;
  let blackKingIdx = -1;
  const whitePawnFiles = [0, 0, 0, 0, 0, 0, 0, 0];
  const blackPawnFiles = [0, 0, 0, 0, 0, 0, 0, 0];
  let whiteBishops = 0;
  let blackBishops = 0;
  const whiteRookFiles: number[] = [];
  const blackRookFiles: number[] = [];

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

      if (piece.type === "p") {
        if (piece.color === "w") whitePawnFiles[file] += 1;
        else blackPawnFiles[file] += 1;
      } else if (piece.type === "b") {
        if (piece.color === "w") whiteBishops += 1;
        else blackBishops += 1;
      } else if (piece.type === "r") {
        (piece.color === "w" ? whiteRookFiles : blackRookFiles).push(file);
      }
    }
  }

  // Bishop pair: two bishops together are worth a real third of a pawn over
  // their raw sum — chess's most reliable material heuristic.
  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;

  // Doubled pawns (-12 per extra pawn on a file) and isolated pawns (-14
  // each: no neighbouring pawn can ever come to its defence).
  for (let f = 0; f < 8; f++) {
    if (whitePawnFiles[f] > 1) score -= 12 * (whitePawnFiles[f] - 1);
    if (blackPawnFiles[f] > 1) score += 12 * (blackPawnFiles[f] - 1);
    const whiteNeighbours =
      (f > 0 ? whitePawnFiles[f - 1]! : 0) + (f < 7 ? whitePawnFiles[f + 1]! : 0);
    const blackNeighbours =
      (f > 0 ? blackPawnFiles[f - 1]! : 0) + (f < 7 ? blackPawnFiles[f + 1]! : 0);
    if (whitePawnFiles[f]! > 0 && whiteNeighbours === 0) score -= 14;
    if (blackPawnFiles[f]! > 0 && blackNeighbours === 0) score += 14;
  }

  // Rooks belong on open files: fully open (no pawn of either colour) is
  // worth more than merely half-open (own pawn gone).
  for (const f of whiteRookFiles) {
    if (whitePawnFiles[f] === 0) score += blackPawnFiles[f] === 0 ? 18 : 9;
  }
  for (const f of blackRookFiles) {
    if (blackPawnFiles[f] === 0) score -= whitePawnFiles[f] === 0 ? 18 : 9;
  }

  // Kings carry no material value — only their placement bonus counts.
  const kingTable = material <= 1300 ? KING_ENDGAME_PST : KING_MIDDLE_PST;
  if (whiteKingIdx >= 0) score += kingTable[whiteKingIdx]!;
  if (blackKingIdx >= 0) score -= kingTable[blackKingIdx]!;

  // Mobility proxy (the move count of the side to move) + small tempo bonus.
  score += chess.turn() === "w" ? chess.moves().length : -chess.moves().length;
  score += chess.turn() === "w" ? 10 : -10;
  return score;
}

/* ------------------------------------------------------------------ */
/* Move ordering                                                        */
/* ------------------------------------------------------------------ */

/** MVV-LVA move ordering: captures and promotions first for better pruning. */
function orderedMoves(chess: Chess): Move[] {
  const moves = chess.moves({ verbose: true });
  return moves.sort((a, b) => {
    const score = (m: Move) => {
      let s = 0;
      if (m.captured) s += 10 * PIECE_VALUES[m.captured]! - PIECE_VALUES[m.piece]!;
      if (m.promotion) s += 900;
      return s;
    };
    return score(b) - score(a);
  });
}

/** Order moves, hoisting a preferred move (the TT's) to the front. */
function orderedMovesWith(chess: Chess, preferred: Move | null): Move[] {
  const moves = orderedMoves(chess);
  if (!preferred) return moves;
  const idx = moves.findIndex(
    (m) =>
      m.from === preferred.from && m.to === preferred.to && m.promotion === preferred.promotion,
  );
  if (idx <= 0) return moves;
  const [best] = moves.splice(idx, 1);
  moves.unshift(best);
  return moves;
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

/** Bound flags for transposition-table entries. */
const TT_EXACT = 0;
const TT_LOWER = 1; // a lower bound: real score >= entry.score
const TT_UPPER = 2; // an upper bound: real score <= entry.score

interface TtEntry {
  depth: number;
  score: number;
  flag: number;
  from: string;
  to: string;
  promotion?: string;
}

/** How deep quiescence keeps resolving captures past the horizon. */
const QUIESCENCE_DEPTH = 4;
/** Maximum plies of consecutive check extensions, so checks can't explode. */
const MAX_CHECK_EXTENSION_PLIES = 12;

class Search {
  private tt = new Map<string, TtEntry>();
  private deadline = 0;
  private stopped = false;
  /** Set once a deadline abort mid-iteration has happened. */
  private aborted = false;

  constructor(timeMs: number) {
    this.deadline = Date.now() + timeMs;
  }

  /** True when the search must stop now. Checked once per node. */
  private get outOfTime(): boolean {
    if (this.stopped) return true;
    if (Date.now() >= this.deadline) {
      this.stopped = true;
      this.aborted = true;
      return true;
    }
    return false;
  }

  get ranOutOfTime(): boolean {
    return this.aborted;
  }

  /**
   * Quiescence search: resolve captures until the position is quiet, so the
   * returned score is one the static evaluation can back. Stand-pat bounds
   * the search; only captures (and promotions) are tried beyond it.
   */
  private quiesce(
    chess: Chess,
    alpha: number,
    beta: number,
    maximizing: boolean,
    qdepth: number,
  ): number {
    if (this.outOfTime) return 0;
    if (chess.isCheckmate()) return maximizing ? -MATE : MATE;
    if (chess.isDraw() || chess.isStalemate()) return 0;

    // Stand-pat: the side to move may decline to capture at all.
    const stand = evaluate(chess);
    if (maximizing) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
    } else {
      if (stand <= alpha) return stand;
      if (stand < beta) beta = stand;
    }
    if (qdepth <= 0) return stand;

    const moves = orderedMoves(chess).filter((m) => Boolean(m.captured) || Boolean(m.promotion));
    for (const m of moves) {
      chess.move(m);
      const score = this.quiesce(chess, alpha, beta, !maximizing, qdepth - 1);
      chess.undo();
      if (this.stopped) return 0;
      if (maximizing) {
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;
      } else {
        if (score < beta) beta = score;
        if (alpha >= beta) break;
      }
    }
    return maximizing ? alpha : beta;
  }

  /**
   * The alpha-beta body over a negamax-like alternation (the engine keeps the
   * explicit maximizing flag so the root and quiescence share conventions).
   * `ply` counts plies from the root; deep checks are not extended forever.
   */
  private negamax(
    chess: Chess,
    depth: number,
    alpha: number,
    beta: number,
    maximizing: boolean,
    ply: number,
  ): number {
    if (this.outOfTime) return 0;
    if (chess.isCheckmate()) return maximizing ? -MATE + ply : MATE - ply;
    if (chess.isDraw() || chess.isStalemate()) return 0;

    const key = chess.fen();
    const cached = this.tt.get(key);
    if (cached && cached.depth >= depth) {
      if (cached.flag === TT_EXACT) return cached.score;
      if (cached.flag === TT_LOWER && cached.score >= beta) return cached.score;
      if (cached.flag === TT_UPPER && cached.score <= alpha) return cached.score;
    }

    // Check extension: checks are searched deeper (capped so perpetual lines
    // can't explode the search). chess.js computes inCheck cheaply.
    let d = depth;
    if (depth > 0 && depth < 5 && ply < MAX_CHECK_EXTENSION_PLIES && chess.inCheck()) d += 1;

    if (d <= 0) return this.quiesce(chess, alpha, beta, maximizing, QUIESCENCE_DEPTH);

    const preferred = cached
      ? this.ttMoveFor(chess, cached.from, cached.to, cached.promotion)
      : null;
    const moves = orderedMovesWith(chess, preferred);

    const originalAlpha = alpha;
    let bestScore = maximizing ? -Infinity : Infinity;
    let bestMove: Move | null = null;

    for (const m of moves) {
      chess.move(m);
      const score = this.negamax(chess, d - 1, alpha, beta, !maximizing, ply + 1);
      chess.undo();
      if (this.stopped) return 0;
      if (maximizing) {
        if (score > bestScore) {
          bestScore = score;
          bestMove = m;
        }
        if (bestScore > alpha) alpha = bestScore;
      } else {
        if (score < bestScore) {
          bestScore = score;
          bestMove = m;
        }
        if (bestScore < beta) beta = bestScore;
      }
      if (alpha >= beta) break;
    }

    if (!bestMove) return maximizing ? alpha : beta;

    const flag = bestScore <= originalAlpha ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    this.tt.set(key, {
      depth: d,
      score: bestScore,
      flag,
      from: bestMove.from,
      to: bestMove.to,
      promotion: bestMove.promotion,
    });
    return bestScore;
  }

  /** Re-find the TT's stored move in the current position's move list. */
  private ttMoveFor(chess: Chess, from: string, to: string, promotion?: string): Move | null {
    if (!from || !to) return null;
    const found = chess
      .moves({ verbose: true })
      .find((m) => m.from === from && m.to === to && m.promotion === promotion);
    return found ?? null;
  }

  /**
   * One full root iteration at `depth`. Returns the best move, its exact
   * score, and EVERY root move's exact score — the chooser needs all of them
   * to pick fairly among near-equals. Scores are exact because the root runs
   * a full window per move (no cutoffs against sibling bounds at depth 0).
   */
  searchRoot(
    chess: Chess,
    depth: number,
    maximizing: boolean,
  ): { completed: boolean; bestMove: Move; bestScore: number; scored: Array<{ move: Move; score: number }> } {
    const moves = orderedMoves(chess);
    const scored: Array<{ move: Move; score: number }> = [];
    let bestMove: Move = moves[0]!;
    let bestScore = maximizing ? -Infinity : Infinity;

    for (const move of moves) {
      chess.move(move);
      const score = this.negamax(chess, depth - 1, -Infinity, Infinity, !maximizing, 1);
      chess.undo();
      if (this.stopped) return { completed: false, bestMove, bestScore, scored };
      scored.push({ move, score });
      if (maximizing ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }
    return { completed: true, bestMove, bestScore, scored };
  }
}

/* ------------------------------------------------------------------ */
/* Opening book                                                         */
/* ------------------------------------------------------------------ */

/**
 * A compact opening book for the top levels, as SAN sequences from the start.
 * Every line is main-line theory; the engine picks one at random and follows
 * it while the game stays on the line, which is stronger and far more varied
 * than search in the first moves. Keep it short and sound — this is about a
 * sensible, varied first four moves, after which search takes over.
 */
const OPENING_BOOK: string[][] = [
  ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"], // Ruy Lopez
  ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "d3", "Bc5", "c3", "d6"], // Italian
  ["e4", "e5", "Nf3", "Nf6", "Nxe5", "d6", "Nf3", "Nxe4", "d4", "d5"], // Petrov main
  ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"], // Najdorf
  ["e4", "c5", "Nf3", "Nc6", "d4", "cxd4", "Nxd4", "g6"], // Sicilian, old
  ["e4", "c5", "Nf3", "e6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "d6"], // Taimanov-ish
  ["e4", "e6", "d4", "d5", "Nc3", "Bb4", "e5", "c5", "a3", "Bxc3+"], // Winawer
  ["e4", "e6", "d4", "d5", "Nc3", "Nf6", "e5", "Nfd7", "f4", "c5"], // Steinitz
  ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Bf5", "Ng3", "Bg6"], // Caro-Kann
  ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "Nf3", "Be7", "Bg5", "O-O"], // QGD
  ["d4", "d5", "c4", "c6", "Nf3", "Nf6", "Nc3", "e6", "Bg5", "h6"], // Semi-Slav
  ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6", "Nf3", "O-O"], // KID
  ["d4", "Nf6", "c4", "e6", "Nf3", "b6", "g3", "Bb7", "Bg2", "Be7"], // QID
  ["d4", "f5", "c4", "Nf6", "g3", "e6", "Bg2", "Be7", "Nf3", "O-O"], // Dutch
  ["Nf3", "Nf6", "c4", "e6", "g3", "d5", "Bg2", "Be7", "O-O", "O-O"], // Catalan-ish
  ["c4", "e5", "Nc3", "Nf6", "Nf3", "Nc6", "g3", "d5", "cxd5", "Nxd5"], // English
  ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5", "d4", "Nf6", "Nf3", "c6"], // Scandi
  ["e4", "d6", "d4", "Nf6", "Nc3", "g6", "Be2", "Bg7", "Nf3", "O-O"], // Pirc
  ["d4", "d5", "Bf4", "Nf6", "e3", "e6", "Nf3", "c5", "c3", "Nc6"], // London
  ["e4", "e5", "Nc3", "Nf6", "f4", "d5", "fxe5", "Nxe4", "Nf3", "Be7"], // Vienna
];

/** Look up the book reply for the current position, if the game is on one. */
function bookMove(sanMoves: string[]): string | null {
  if (sanMoves.length > 10) return null;
  const replies: string[] = [];
  outer: for (const line of OPENING_BOOK) {
    if (line.length <= sanMoves.length) continue;
    for (let i = 0; i < sanMoves.length; i++) {
      if (line[i] !== sanMoves[i]) continue outer;
    }
    const reply = line[sanMoves.length];
    if (reply) replies.push(reply);
  }
  if (replies.length === 0) return null;
  // Draw from EVERY line that reaches this position. The old code returned
  // the first match, which was the same line every game — 1.e4 was always
  // answered 1…e5 (the Ruy Lopez row comes first), so a Grandmaster replayed
  // identical games move for move against the same opening. One random draw
  // per position makes the repertoire a repertoire instead of a script.
  return replies[Math.floor(Math.random() * replies.length)]!;
}

/**
 * SAN history for the current FEN, rebuilt from the game's move records.
 * A FEN alone carries no move list, so the book (and any future history-
 * aware search term) needs the caller to hand the moves over.
 */
export function sanHistoryOf(moves: Array<{ from: string; to: string; promotion?: string }>): string[] {
  const chess = new Chess();
  const san: string[] = [];
  for (const m of moves) {
    try {
      const move = chess.move({
        from: m.from as never,
        to: m.to as never,
        promotion: (m.promotion || undefined) as never,
      });
      san.push(move.san);
    } catch {
      break; // a corrupted record ends the reconstruction, never throws
    }
  }
  return san;
}

/* ------------------------------------------------------------------ */
/* Level personalities and the chooser                                  */
/* ------------------------------------------------------------------ */

/** Per-level search parameters the levels in lib/types.ts reference. */
export interface SearchProfile {
  /** Hard think time in milliseconds — the iterative-deepening budget. */
  timeMs: number;
  /** Depth ceiling, so the weaker levels stay both fast and fallible. */
  maxDepth: number;
  /** Whether this level follows the opening book. */
  book: boolean;
}

/** Mirrors AI_LEVELS in lib/types.ts by id (kept together with the search). */
const SEARCH_PROFILES: Record<AiDifficulty, SearchProfile> = {
  beginner: { timeMs: 120, maxDepth: 2, book: false },
  casual: { timeMs: 200, maxDepth: 2, book: false },
  club: { timeMs: 350, maxDepth: 3, book: false },
  advanced: { timeMs: 600, maxDepth: 4, book: false },
  expert: { timeMs: 1000, maxDepth: 5, book: true },
  sovereign: { timeMs: 1600, maxDepth: 6, book: true },
  apex: { timeMs: 2500, maxDepth: 8, book: true },
  // Native Stockfish normally never reaches the built-in search — it plays
  // through its own UCI worker. This profile only answers when the native
  // engine is unavailable (no worker support, load failure), so the level
  // degrades to the house maximum instead of stalling the game.
  stockfish: { timeMs: 2500, maxDepth: 8, book: true },
};

export function searchProfileFor(difficulty: AiDifficulty): SearchProfile {
  return SEARCH_PROFILES[difficulty] ?? SEARCH_PROFILES.casual!;
}

export interface AiMove {
  from: string;
  to: string;
  promotion?: string;
}

/**
 * Pick the AI's move for the given position. Returns null when the side to
 * move has no legal moves (checkmate / stalemate already handled by caller).
 *
 * `sanHistory` is the game's SAN move list — required for the opening book.
 * A FEN alone carries no move list, so without it the book is skipped and
 * the search runs: guessing the ply count from the FEN's move counter while
 * treating the game as at move one once made the book play its opening SAN
 * blindly into a mid-game position (the fool's-mate regression caught it).
 */
export function chooseAiMove(
  fen: string,
  difficulty: AiDifficulty = "casual",
  sanHistory: string[] = [],
  /** Think budget override (ms) — callers scale it to the game's clock so a
      bullet game never watches the bot burn 2.5s a move. Absent → profile. */
  thinkMs?: number,
): AiMove | null {
  const chess = new Chess(fen);
  const moves = orderedMoves(chess);
  if (moves.length === 0) return null;

  const level = aiLevelFor(difficulty);
  const profile = searchProfileFor(difficulty);

  // Weaker levels sometimes play a random legal move — the classic way lower
  // ratings hang pieces — while stronger levels always take the best line.
  if (level.blunderChance > 0 && Math.random() < level.blunderChance) {
    const random = moves[Math.floor(Math.random() * moves.length)]!;
    return { from: random.from, to: random.to, promotion: random.promotion };
  }

  // Opening book for the top levels: follow a real line while the game is on
  // one, line chosen at random per game. Weaker levels just search — their
  // imperfection is the point. The book is only consulted when the history
  // we were handed genuinely corresponds to this position (same ply count
  // per the FEN's move counter) — otherwise the search runs instead.
  const plies = (chess.moveNumber() - 1) * 2 + (chess.turn() === "b" ? 1 : 0);
  if (profile.book && sanHistory.length === plies) {
    const book = bookMove(sanHistory);
    if (book) {
      try {
        const bm = chess.move(book);
        return { from: bm.from, to: bm.to, promotion: bm.promotion };
      } catch {
        /* fall through to search */
      }
    }
  }

  const maximizing = chess.turn() === "w";

  /**
   * Iterative deepening with a deadline over a persistent transposition
   * table. The best move from the last COMPLETED depth plays; a deadline
   * abort mid-iteration simply keeps the previous depth's choice.
   */
  const search = new Search(Math.max(60, Math.min(profile.timeMs, thinkMs ?? profile.timeMs)));
  let best: AiMove = { from: moves[0]!.from, to: moves[0]!.to, promotion: moves[0]!.promotion };
  let lastScored: Array<{ move: Move; score: number }> = [];
  let completed = false;

  for (let depth = 1; depth <= profile.maxDepth; depth++) {
    const result = search.searchRoot(chess, depth, maximizing);
    if (!result.completed) break;
    best = {
      from: result.bestMove.from,
      to: result.bestMove.to,
      promotion: result.bestMove.promotion,
    };
    lastScored = result.scored;
    completed = true;
    if (Math.abs(result.bestScore) > MATE - 1000) break; // mate found
  }

  /**
   * Variety: among the root moves the last completed depth scored within the
   * level's margin of best, pick at random. The engine is deterministic, so
   * this is the whole reason two games against the same level differ. Mate
   * scores dwarf any margin, so a forced win is never traded away — the
   * candidate set collapses to the mating moves on its own.
   */
  if (completed && lastScored.length > 1 && level.variety > 0) {
    const bestEntry = lastScored.reduce((a, b) =>
      maximizing ? (b.score > a.score ? b : a) : (b.score < a.score ? b : a),
    );
    const threshold = maximizing ? bestEntry.score - level.variety : bestEntry.score + level.variety;
    const inMargin = lastScored.filter((r) =>
      maximizing ? r.score >= threshold : r.score <= threshold,
    );
    if (inMargin.length > 1) {
      const pick = inMargin[Math.floor(Math.random() * inMargin.length)]!.move;
      best = { from: pick.from, to: pick.to, promotion: pick.promotion };
    }
  }

  return best;
}
