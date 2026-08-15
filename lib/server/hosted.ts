import { applyMoveToGame, joinPlayerToGame, resignPlayerFromGame } from "@/lib/game-logic";
import { getGameStorage } from "@/lib/server/storage";
import { buildRuleSummary } from "@/lib/summary";
import {
  isGameOver,
  type CreateGameOptions,
  type GameIndexEntry,
  type GameState,
  type PlayerStats,
} from "@/lib/types";
import { START_FEN } from "@/lib/types";
import { randomHex } from "@/lib/utils";

/**
 * Shared multiplayer store. Games are small JSON blobs keyed by game id, so
 * two players on different devices can join the same game. Storage comes from
 * lib/server/storage.ts: Vercel KV / Upstash Redis when keys are set
 * (production), otherwise a built-in file store under `.data/`.
 *
 * Alongside game state it maintains real derived data:
 *  - a games index (for Games / Watch / homepage lists)
 *  - per-player stats with a conventional ELO rating (updated only when a
 *    real rated game between two distinct humans finishes)
 *  - a leaderboard sorted by rating
 */

const keyFor = (id: string) => `chainmate:game:${id}`;
const INDEX_KEY = "chainmate:index:games:v1";
const LEADERBOARD_KEY = "chainmate:index:leaderboard:v1";
const STATS_PREFIX = "chainmate:player:";
const INDEX_MAX = 400;
const LEADERBOARD_MAX = 100;
const START_RATING = 1200;
const K = 32;

/* ------------------------------------------------------------------ */
/* Games index                                                         */
/* ------------------------------------------------------------------ */

function entryFromGame(game: GameState): GameIndexEntry {
  return {
    id: game.id,
    updatedAt: game.updatedAt ?? Date.now(),
    createdAt: game.createdAt ?? Date.now(),
    creator: game.creator,
    opponent: game.opponent,
    status: game.status,
    winner: game.winner,
    timeControl: game.timeControl,
    visibility: game.visibility,
    endedAt: game.endedAt,
  };
}

async function readIndex(): Promise<GameIndexEntry[]> {
  const raw = await getGameStorage().get(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as GameIndexEntry[];
  } catch {
    return [];
  }
}

async function upsertIndex(entry: GameIndexEntry): Promise<void> {
  const entries = await readIndex();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.unshift(entry);
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  await getGameStorage().set(INDEX_KEY, JSON.stringify(entries.slice(0, INDEX_MAX)));
}

/* ------------------------------------------------------------------ */
/* Player stats + leaderboard                                          */
/* ------------------------------------------------------------------ */

function defaultStats(playerId: string): PlayerStats {
  return {
    playerId,
    rating: START_RATING,
    wins: 0,
    losses: 0,
    draws: 0,
    games: 0,
    updatedAt: Date.now(),
  };
}

export async function getPlayerStats(playerId: string): Promise<PlayerStats> {
  if (!playerId) return defaultStats(playerId);
  const raw = await getGameStorage().get(`${STATS_PREFIX}${playerId}`);
  if (!raw) return defaultStats(playerId);
  try {
    return JSON.parse(raw) as PlayerStats;
  } catch {
    return defaultStats(playerId);
  }
}

async function readLeaderboard(): Promise<PlayerStats[]> {
  const raw = await getGameStorage().get(LEADERBOARD_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PlayerStats[];
  } catch {
    return [];
  }
}

async function writeStats(stats: PlayerStats): Promise<void> {
  await getGameStorage().set(`${STATS_PREFIX}${stats.playerId}`, JSON.stringify(stats));
  const list = await readLeaderboard();
  const idx = list.findIndex((p) => p.playerId === stats.playerId);
  if (idx >= 0) list[idx] = stats;
  else list.push(stats);
  list.sort((a, b) => b.rating - a.rating || b.games - a.games);
  await getGameStorage().set(
    LEADERBOARD_KEY,
    JSON.stringify(list.slice(0, LEADERBOARD_MAX)),
  );
}

export async function getLeaderboard(): Promise<PlayerStats[]> {
  return readLeaderboard();
}

/**
 * Apply ELO ratings when a real game between two distinct human players
 * finishes. Runs exactly once per game (guarded by endedAt).
 */
async function applyRatingsIfFinished(prev: GameState, next: GameState): Promise<void> {
  if (prev.endedAt || isGameOver(prev.status)) return;
  if (!isGameOver(next.status)) return;
  const p1 = next.creator;
  const p2 = next.opponent;
  if (!p1 || !p2 || p1 === "ai" || p2 === "ai" || p1 === p2) return;

  const [s1, s2] = await Promise.all([getPlayerStats(p1), getPlayerStats(p2)]);
  let score1: number;
  if (next.status === "draw" || next.status === "stalemate") score1 = 0.5;
  else if (next.winner === p1) score1 = 1;
  else score1 = 0;
  const score2 = 1 - score1;

  const e1 = 1 / (1 + Math.pow(10, (s2.rating - s1.rating) / 400));
  const e2 = 1 - e1;

  s1.rating = Math.max(100, Math.round(s1.rating + K * (score1 - e1)));
  s2.rating = Math.max(100, Math.round(s2.rating + K * (score2 - e2)));
  s1.games += 1;
  s2.games += 1;
  s1.wins += score1 === 1 ? 1 : 0;
  s1.losses += score1 === 0 ? 1 : 0;
  s1.draws += score1 === 0.5 ? 1 : 0;
  s2.wins += score2 === 1 ? 1 : 0;
  s2.losses += score2 === 0 ? 1 : 0;
  s2.draws += score2 === 0.5 ? 1 : 0;
  s1.updatedAt = s2.updatedAt = Date.now();

  await Promise.all([writeStats(s1), writeStats(s2)]);
}

/* ------------------------------------------------------------------ */
/* Game operations                                                     */
/* ------------------------------------------------------------------ */

async function writeGame(game: GameState): Promise<void> {
  await getGameStorage().set(keyFor(game.id), JSON.stringify(game));
  await upsertIndex(entryFromGame(game));
}

export async function createHostedGame(
  playerId: string,
  options: CreateGameOptions = {},
): Promise<GameState> {
  const now = Date.now();
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
    timeControl: options.timeControl,
    visibility: options.visibility === "public" ? "public" : "private",
    createdAt: now,
    updatedAt: now,
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
  const now = Date.now();
  const next: GameState = {
    ...res.game,
    startedAt: res.game.startedAt ?? now,
    updatedAt: now,
  };
  await writeGame(next);
  return next;
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
  let next: GameState = res.game;
  if (isGameOver(next.status) && !next.endedAt) {
    next = {
      ...next,
      endedAt: Date.now(),
      updatedAt: Date.now(),
      summary: next.summary || buildRuleSummary(next),
    };
    await applyRatingsIfFinished(game, next);
  } else {
    next = { ...next, updatedAt: Date.now() };
  }
  await writeGame(next);
  return next;
}

export async function resignHostedGame(id: string, playerId: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = resignPlayerFromGame(game, playerId);
  if (!res.ok) throw new Error(res.error);
  let next: GameState = res.game;
  if (isGameOver(next.status) && !next.endedAt) {
    next = {
      ...next,
      endedAt: Date.now(),
      updatedAt: Date.now(),
      summary: next.summary || buildRuleSummary(next),
    };
    await applyRatingsIfFinished(game, next);
  } else {
    next = { ...next, updatedAt: Date.now() };
  }
  await writeGame(next);
  return next;
}

export async function summarizeHostedGame(id: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  if (!isGameOver(game.status)) throw new Error("The game is still in progress");
  if (game.summary) return game;
  const next: GameState = { ...game, summary: buildRuleSummary(game), updatedAt: Date.now() };
  await writeGame(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

async function fetchGames(entries: GameIndexEntry[], max: number): Promise<GameState[]> {
  const out: GameState[] = [];
  for (const e of entries.slice(0, max)) {
    const game = await getHostedGame(e.id);
    if (game) out.push(game);
  }
  return out;
}

/** Real list data for Games / Watch / homepage. */
export async function listHostedGames(opts: {
  playerId?: string;
  scope?: "mine" | "watch" | "recent";
}): Promise<{ games?: GameState[]; live?: GameIndexEntry[]; recent?: GameIndexEntry[] }> {
  const entries = await readIndex();

  if (opts.scope === "mine" && opts.playerId) {
    const mine = entries.filter(
      (e) => e.creator === opts.playerId || e.opponent === opts.playerId,
    );
    return { games: await fetchGames(mine, 25) };
  }

  if (opts.scope === "watch") {
    const live = entries.filter((e) => e.visibility === "public" && e.status === "waiting");
    const done = entries.filter((e) => isGameOver(e.status));
    return { live: live.slice(0, 12), recent: done.slice(0, 12) };
  }

  if (opts.scope === "recent") {
    const done = entries.filter((e) => isGameOver(e.status));
    return { games: await fetchGames(done, 5) };
  }

  return { games: await fetchGames(entries, 12) };
}

/** The current player's stats + their recent games (for the profile page). */
export async function getPlayerProfile(playerId: string): Promise<{
  stats: PlayerStats;
  games: GameState[];
}> {
  const stats = await getPlayerStats(playerId);
  const entries = await readIndex();
  const mine = entries.filter(
    (e) => e.creator === playerId || e.opponent === playerId,
  );
  return { stats, games: await fetchGames(mine, 15) };
}
