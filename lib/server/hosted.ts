import { applyMoveToGame, joinPlayerToGame, resignPlayerFromGame } from "@/lib/game-logic";
import { getGameStorage } from "@/lib/server/storage";
import { buildRuleSummary } from "@/lib/summary";
import { isGameOver, type GameState } from "@/lib/types";
import { START_FEN } from "@/lib/types";
import { randomHex } from "@/lib/utils";

/**
 * Shared multiplayer store. Games are small JSON blobs keyed by game id, so
 * two players on different devices can join the same game. Storage comes from
 * lib/server/storage.ts: Vercel KV when KV_REST_API_URL + KV_REST_API_TOKEN
 * are set (production), otherwise a built-in file store under `.data/` that
 * works with zero configuration in previews and containers.
 */

const keyFor = (id: string) => `chainmate:game:${id}`;

async function writeGame(game: GameState): Promise<void> {
  await getGameStorage().set(keyFor(game.id), JSON.stringify(game));
}

export async function createHostedGame(playerId: string): Promise<GameState> {
  const id = `hosted_${randomHex(6)}`;
  const game: GameState = {
    id,
    creator: playerId,
    opponent: "",
    status: "waiting",
    winner: "",
    fen: START_FEN,
    moves: [],
    commentary: [],
    summary: "",
    backend: "hosted",
  };
  await writeGame(game);
  return game;
}

export async function getHostedGame(id: string): Promise<GameState | null> {
  const raw = await getGameStorage().get(keyFor(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GameState;
  } catch {
    return null;
  }
}

export async function joinHostedGame(id: string, playerId: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = joinPlayerToGame(game, playerId);
  if (!res.ok) throw new Error(res.error);
  await writeGame(res.game);
  return res.game;
}

export async function submitHostedMove(
  id: string,
  playerId: string,
  from: string,
  to: string,
  promotion?: string,
): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = applyMoveToGame(game, playerId, from, to, promotion);
  if (!res.ok) throw new Error(res.error);
  await writeGame(res.game);
  return res.game;
}

export async function resignHostedGame(id: string, playerId: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = resignPlayerFromGame(game, playerId);
  if (!res.ok) throw new Error(res.error);
  await writeGame(res.game);
  return res.game;
}

export async function summarizeHostedGame(id: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  if (!isGameOver(game.status)) throw new Error("The game is still in progress");
  if (game.summary) return game;
  const next: GameState = { ...game, summary: buildRuleSummary(game) };
  await writeGame(next);
  return next;
}
