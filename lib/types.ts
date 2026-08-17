/** Shared types for the ChainMate dApp. */

export type GameBackend = "local" | "hosted" | "genlayer";

/** Strength preset for the built-in on-device chess AI. */
export type AiDifficulty = "casual" | "competitive";

/** The opponent id used by single-player games (plays Black). */
export const AI_PLAYER_ID = "ai";

export type GameStatus =
  | "waiting"
  | "active"
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resigned"
  | "timeout";

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
  summary: string;
  backend: GameBackend;
  /** Only set on single-player games — how strong the AI opponent plays. */
  aiDifficulty?: AiDifficulty;
  /** Selected time control, e.g. "10 + 0". PvP games only. */
  timeControl?: string;
  /** Whether the game shows up in the public Watch list. Defaults to private. */
  visibility?: "public" | "private";
  /** Pending draw offer: the player id who offered, and when. Cleared on
   *  accept, decline or the next move. */
  drawOffer?: { by: string; at: number };
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
  rating: number;
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
];

export function isGameOver(status: GameStatus): boolean {
  return GAME_OVER_STATUSES.includes(status);
}

export function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
