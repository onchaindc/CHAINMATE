/** Shared types for the ChainMate dApp. */

export type GameBackend = "local" | "genlayer";

export type GameStatus =
  | "waiting"
  | "active"
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resigned";

export type PlayerSide = "white" | "black";

export interface MoveRecord {
  number: number;
  side: PlayerSide;
  from: string;
  to: string;
  promotion: string;
  san: string;
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
  /** Black player's address / id ("" while waiting). */
  opponent: string;
  status: GameStatus;
  winner: string;
  fen: string;
  moves: MoveRecord[];
  commentary: CommentaryEntry[];
  summary: string;
  backend: GameBackend;
}

export interface GameStore {
  createGame(): Promise<GameState>;
  joinGame(id: string): Promise<GameState>;
  getGame(id: string): Promise<GameState | null>;
  submitMove(id: string, from: string, to: string, promotion?: string): Promise<GameState>;
  resign(id: string): Promise<GameState>;
  generateSummary(id: string): Promise<GameState>;
  /** Subscribe to live updates for a game. Returns an unsubscribe fn. */
  subscribe(id: string, callback: (state: GameState) => void): () => void;
  /** This browser's player identity (address-like id). */
  getMyPlayerId(): string;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const GAME_OVER_STATUSES: GameStatus[] = ["checkmate", "stalemate", "draw", "resigned"];

export function isGameOver(status: GameStatus): boolean {
  return GAME_OVER_STATUSES.includes(status);
}

export function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
