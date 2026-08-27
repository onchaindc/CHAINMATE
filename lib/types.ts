/** Shared types for the ChainMate dApp. */

export type GameBackend = "local" | "hosted" | "genlayer";

/** Strength preset for the built-in chess AI opponent. */
export type AiDifficulty = "beginner" | "casual" | "club" | "advanced" | "expert";

/** One named computer opponent — a real name and rating, chess.com-style. */
export interface AiLevel {
  id: AiDifficulty;
  /** Display name of this computer opponent. */
  name: string;
  /** Rating the computer plays at (display only — computer games are casual). */
  rating: number;
  /** Short player-facing description. */
  blurb: string;
  /** Search depth in ply — higher is stronger (and slower). */
  depth: number;
  /** Chance the computer plays a random legal move instead of its best. */
  blunderChance: number;
  /**
   * How far below best a move may score, in centipawns, and still be picked.
   *
   * The engine is deterministic: the same position always produced the same
   * move, so every game against a level ran identically. Anything within this
   * margin of the best score counts as equally playable and one is chosen at
   * random, which is what makes games differ. Kept small deliberately — it only
   * ever decides between moves that are already near-equal.
   */
  variety: number;
}

export const AI_LEVELS: AiLevel[] = [
  { id: "beginner", name: "Pawn", rating: 600, blurb: "New to the game — hangs pieces you can punish.", depth: 1, blunderChance: 0.3, variety: 40 },
  { id: "casual", name: "Nova", rating: 900, blurb: "A relaxed club player who makes the odd slip.", depth: 1, blunderChance: 0.12, variety: 30 },
  { id: "club", name: "Atlas", rating: 1200, blurb: "Solid fundamentals — punishes blunders.", depth: 2, blunderChance: 0.06, variety: 20 },
  { id: "advanced", name: "Onyx", rating: 1600, blurb: "Sharp tactical play with few mistakes.", depth: 2, blunderChance: 0.02, variety: 15 },
  { id: "expert", name: "Zenith", rating: 2000, blurb: "Relentless — bring your A-game.", depth: 3, blunderChance: 0, variety: 10 },
];

/** Map any stored difficulty value (incl. legacy ids) onto a known level. */
export function normalizeAiDifficulty(d?: string): AiDifficulty {
  if (d === "competitive") return "advanced"; // legacy id from older builds
  if (d && AI_LEVELS.some((l) => l.id === d)) return d as AiDifficulty;
  return "casual";
}

/** Full level info for a stored difficulty value (with legacy fallback). */
export function aiLevelFor(d?: string): AiLevel {
  return AI_LEVELS.find((l) => l.id === normalizeAiDifficulty(d)) ?? AI_LEVELS[1];
}

/** The opponent id used by single-player games (plays Black). */
export const AI_PLAYER_ID = "ai";

export type GameStatus =
  | "waiting"
  | "active"
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resigned"
  | "timeout"
  | "aborted";

export type PlayerSide = "white" | "black";

export interface MoveRecord {
  number: number;
  side: PlayerSide;
  from: string;
  to: string;
  promotion: string;
  san: string;
  /** Unix ms when the move was played — drives the real chess clocks. */
  at?: number;
}

export interface CommentaryEntry {
  /** SAN of the move this commentary is about ("" for non-move events). */
  move: string;
  side: PlayerSide;
  text: string;
  /** Where the text came from: on-chain contract / local engine / LLM. */
  source?: "chain" | "local" | "ai";
}

export interface GameState {
  id: string;
  /** White player's address / id. */
  creator: string;
  /** Black player's address / id ("" while waiting, "ai" for single-player). */
  opponent: string;
  status: GameStatus;
  winner: string;
  fen: string;
  moves: MoveRecord[];
  commentary: CommentaryEntry[];
  /**
   * Deterministic, rule-derived match report (lib/summary.ts). Written the
   * instant a game ends so the result screen always has something to show.
   *
   * This is the FALLBACK and is never the GenLayer analysis. The two used to
   * share this one field, which made the on-chain analyzer unreachable: every
   * end-game path filled `summary` first, and the analyzer skipped any game
   * that already had one. They are separate state now — see `analysis`.
   */
  summary: string;
  /**
   * The completed LLM match analysis — the real thing, not the fallback. For
   * hosted games that means the GenLayer on-chain analysis, produced by
   * deploying contracts/analyze.py and running it through validator consensus;
   * for local games it is the /api/ai response. Present only once that has
   * actually finished, which is what makes it safe to use as the "analysis is
   * done" gate.
   */
  analysis?: string;
  /**
   * Why `analysis` is still absent — keys unconfigured, network, consensus
   * failure. Absent `analysis` with no error means it was never requested;
   * with an error it may be retried.
   */
  analysisError?: string;
  backend: GameBackend;
  /** Only set on single-player games — how strong the AI opponent plays. */
  aiDifficulty?: AiDifficulty;
  /** Selected time control, e.g. "10 + 0". PvP games only. */
  timeControl?: string;
  /** Whether the game shows up in the public Watch list. Defaults to private. */
  visibility?: "public" | "private";
  /**
   * The player this game was *sent* to, on a direct challenge — set while the
   * game is still `waiting`, cleared in effect the moment they accept (at which
   * point they are the `opponent`). Only the invited player may accept, which is
   * what separates a challenge from an open game anyone can join.
   */
  invited?: string;
  /** Pending draw offer: the player id who offered, and when. Cleared on
   *  accept, decline or the next move. */
  drawOffer?: { by: string; at: number };
  /**
   * Rating change this game produced, per player id — written once, by the
   * server, at the moment the game ended. It lives on the game (not only in
   * each player's stats) so the result screen can show both sides' deltas from
   * the game alone: player stats are cached per server instance, so a client
   * whose request lands elsewhere would otherwise see no change at all.
   */
  ratings?: Record<string, { before: number; after: number; change: number }>;
  /** Unix ms timestamps, set by the stores that persist games. */
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  endedAt?: number;
}

/** A single awarded achievement. */
export interface AchievementEntry {
  code: string;
  earnedAt: number;
}

/** One rated game's rating delta, kept for historical rating tracking. */
export interface RatingChangeEntry {
  gameId: string;
  ratingBefore: number;
  ratingAfter: number;
  opponentRating: number;
  change: number;
}

/**
 * Persistent per-player stats, derived from real completed rated games.
 * All fields are written server-side only — the client can never modify
 * ratings, streaks or achievements.
 */
export interface PlayerStats {
  playerId: string;
  /** Public display name. Guests get "Guest_XXXX", accounts pick their own. */
  username?: string;
  /** True while the player is an anonymous guest (provisional rating). */
  isGuest?: boolean;
  /** ISO 3166-1 alpha-2 country code when the player set one (optional). */
  country?: string;
  rating: number;
  /** Glicko rating deviation — confidence in the rating (30 solid → 350 new). */
  rd?: number;
  /** Unix ms of the player's last rated game (drives rating confidence decay). */
  lastPlayedAt?: number | null;
  /** Highest rating ever reached (tracked server-side). */
  peakRating: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  /** Consecutive wins/losses — positive = winning streak. */
  currentStreak: number;
  bestStreak: number;
  /** Recent rated games with their rating deltas (newest first). */
  ratingHistory: RatingChangeEntry[];
  /** Achievements awarded from real game data (server-side only). */
  achievements: AchievementEntry[];
  updatedAt: number;
}

/** One player shown in the live Watch feed (real server data). */
export interface LivePlayerInfo {
  id: string;
  /** Public username when the player has one (else the client shows a short id). */
  name?: string;
  /** Current ELO rating (always present for real players). */
  rating?: number;
  /** ISO country code when the player set one (for flags). */
  country?: string;
  isAi?: boolean;
}

/**
 * A game currently in LIVE state, as served by the Watch API. Every active
 * game is automatically registered in the live feed when it starts and is
 * removed the moment it ends — no manual "publish" step.
 */
export interface LiveGameEntry {
  id: string;
  creator: LivePlayerInfo;
  opponent: LivePlayerInfo;
  timeControl?: string;
  /** Real ply count — updates with every move. */
  moveCount: number;
  startedAt?: number;
  updatedAt: number;
}

/** Lightweight index entry used by Games / Watch / homepage lists. */
export interface GameIndexEntry {
  id: string;
  updatedAt: number;
  createdAt: number;
  creator: string;
  opponent: string;
  status: GameStatus;
  winner: string;
  timeControl?: string;
  visibility?: "public" | "private";
  /** Target of a pending direct challenge (see GameState.invited). */
  invited?: string;
  endedAt?: number;
}

export interface CreateGameOptions {
  timeControl?: string;
  visibility?: "public" | "private";
}

export interface GameStore {
  createGame(options?: CreateGameOptions): Promise<GameState>;
  /** Start a single-player game against the built-in on-device AI. */
  createAiGame(difficulty?: AiDifficulty): Promise<GameState>;
  joinGame(id: string): Promise<GameState>;
  getGame(id: string): Promise<GameState | null>;
  submitMove(id: string, from: string, to: string, promotion?: string): Promise<GameState>;
  /** Let the AI opponent (if this is an AI game) make its move. */
  submitAiMove(id: string): Promise<GameState>;
  resign(id: string): Promise<GameState>;
  /** Offer a draw to the opponent (pending until accepted or declined). */
  offerDraw(id: string): Promise<GameState>;
  /** Accept or decline the opponent's pending draw offer. */
  respondDraw(id: string, accept: boolean): Promise<GameState>;
  /** Abort a game before any move is played (no rating impact). */
  abort(id: string): Promise<GameState>;
  /** Start a fresh match against the same opponent (hosted games). */
  rematch(id: string): Promise<GameState>;
  /** Settle a flag fall now; returns the (possibly ended) current state. */
  resolveTimeout(id: string): Promise<GameState>;
  generateSummary(id: string): Promise<GameState>;
  /** Subscribe to live updates for a game. Returns an unsubscribe fn. */
  subscribe(id: string, callback: (state: GameState) => void): () => void;
  /** This browser's player identity (address-like id). */
  getMyPlayerId(): string;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const GAME_OVER_STATUSES: GameStatus[] = [
  "checkmate",
  "stalemate",
  "draw",
  "resigned",
  "timeout",
  "aborted",
];

export function isGameOver(status: GameStatus): boolean {
  return GAME_OVER_STATUSES.includes(status);
}

/**
 * Whether a game belongs in a player's record.
 *
 * An aborted game is over but never happened — no moves, no result, nothing
 * rated — so a row for one reports nothing and only pads the history. Note this
 * is deliberately *not* folded into `GAME_OVER_STATUSES`: an aborted game is
 * genuinely finished, and `isGameOver` has to keep saying so or the board would
 * stay live. It just isn't a match anyone played.
 */
export function isPlayedGame(game: { status: GameStatus }): boolean {
  return game.status !== "aborted";
}

/**
 * True when `next` is an *older* snapshot of the same game than `prev`.
 *
 * Clients learn about the opponent's moves by polling, so two requests can be
 * in flight at once and a slow response can land after a fast one. Applying it
 * blindly rewinds the board mid-game, or un-finishes a game that just ended —
 * which is what makes the end-game modal flicker between results. A game only
 * ever moves forwards, so any snapshot that goes backwards is stale and safe to
 * drop: the next poll carries the current state anyway.
 */
export function isStaleGameState(prev: GameState, next: GameState): boolean {
  // A different game entirely (e.g. a rematch) — not a stale version of this one.
  if (prev.id !== next.id) return false;
  // A finished game never reopens.
  if (isGameOver(prev.status) && !isGameOver(next.status)) return true;
  // Moves are only ever appended.
  if (next.moves.length !== prev.moves.length) {
    return next.moves.length < prev.moves.length;
  }
  // An opponent never un-joins.
  if (prev.opponent && !next.opponent) return true;
  // Same move count: fall back to the server's own write timestamp.
  const prevAt = prev.updatedAt ?? 0;
  const nextAt = next.updatedAt ?? 0;
  return prevAt > 0 && nextAt > 0 && nextAt < prevAt;
}

export function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
