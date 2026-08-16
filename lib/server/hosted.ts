import { applyMoveToGame, joinPlayerToGame, resignPlayerFromGame } from "@/lib/game-logic";
import { getGameStorage } from "@/lib/server/storage";
import { earnedAchievements, earnedCodes, type AchievementContext } from "@/lib/achievements";
import { buildRuleSummary } from "@/lib/summary";
import { supabaseConfigured } from "@/lib/supabase/config";
import {
  upsertAchievements,
  upsertGameRecord,
  upsertProfiles,
} from "@/lib/supabase/db";
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
    peakRating: START_RATING,
    wins: 0,
    losses: 0,
    draws: 0,
    games: 0,
    currentStreak: 0,
    bestStreak: 0,
    ratingHistory: [],
    achievements: [],
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
 * finishes. Runs exactly once per game (guarded by endedAt). Also updates
 * peak rating, win/loss streaks, per-game rating history and achievements —
 * all server-authoritative. Finally mirrors the results to Supabase when it
 * is configured (best-effort; Supabase problems never affect the game).
 */
async function applyRatingsIfFinished(prev: GameState, next: GameState): Promise<void> {
  if (prev.endedAt || isGameOver(prev.status)) return;
  if (!isGameOver(next.status)) return;
  const p1 = next.creator;
  const p2 = next.opponent;
  if (!p1 || !p2 || p1 === "ai" || p2 === "ai" || p1 === p2) return;

  const [s1, s2] = await Promise.all([getPlayerStats(p1), getPlayerStats(p2)]);
  const ratingBefore1 = s1.rating;
  const ratingBefore2 = s2.rating;
  let score1: number;
  if (next.status === "draw" || next.status === "stalemate") score1 = 0.5;
  else if (next.winner === p1) score1 = 1;
  else score1 = 0;
  const score2 = 1 - score1;

  const e1 = 1 / (1 + Math.pow(10, (s2.rating - s1.rating) / 400));
  const e2 = 1 - e1;

  const now = Date.now();
  const rating1 = Math.max(100, Math.round(s1.rating + K * (score1 - e1)));
  const rating2 = Math.max(100, Math.round(s2.rating + K * (score2 - e2)));

  const applyStats = (
    s: PlayerStats,
    score: number,
    before: number,
    oppBefore: number,
    rating: number,
  ) => {
    s.rating = rating;
    s.peakRating = Math.max(s.peakRating, rating);
    s.games += 1;
    s.wins += score === 1 ? 1 : 0;
    s.losses += score === 0 ? 1 : 0;
    s.draws += score === 0.5 ? 1 : 0;
    // Streaks: positive = wins in a row, negative = losses in a row.
    if (score === 1) s.currentStreak = (s.currentStreak > 0 ? s.currentStreak : 0) + 1;
    else if (score === 0) s.currentStreak = (s.currentStreak < 0 ? s.currentStreak : 0) - 1;
    else s.currentStreak = 0;
    s.bestStreak = Math.max(s.bestStreak, s.currentStreak);
    s.ratingHistory = [
      {
        gameId: next.id,
        ratingBefore: before,
        ratingAfter: rating,
        opponentRating: oppBefore,
        change: rating - before,
      },
      ...s.ratingHistory,
    ].slice(0, 50);

    const ctx: AchievementContext = {
      games: s.games,
      wins: s.wins,
      rating: s.rating,
      currentStreak: Math.max(0, s.currentStreak),
      beatHigherRated: score === 1 && oppBefore > before,
    };
    const have = earnedCodes(s);
    const fresh = earnedAchievements(ctx).filter((code) => !have.has(code));
    if (fresh.length > 0) {
      s.achievements = [
        ...s.achievements,
        ...fresh.map((code) => ({ code, earnedAt: now })),
      ];
    }
    s.updatedAt = now;
  };

  applyStats(s1, score1, ratingBefore1, ratingBefore2, rating1);
  applyStats(s2, score2, ratingBefore2, ratingBefore1, rating2);

  await Promise.all([writeStats(s1), writeStats(s2)]);

  if (supabaseConfigured()) {
    try {
      await Promise.all([
        upsertProfiles([s1, s2]),
        upsertGameRecord(next),
        upsertAchievements(s1),
        upsertAchievements(s2),
      ]);
    } catch {
      // Best-effort persistence — chess must never break because of this.
    }
  }
}

/**
 * Update the public identity on a player's record (guest name → chosen
 * username on account creation). Ratings/stats are never touched here.
 */
export async function updatePlayerIdentity(
  playerId: string,
  update: { username?: string; isGuest?: boolean },
): Promise<PlayerStats> {
  const stats = await getPlayerStats(playerId);
  const next: PlayerStats = {
    ...stats,
    username: update.username ?? stats.username,
    isGuest: update.isGuest ?? stats.isGuest,
    updatedAt: Date.now(),
  };
  await writeStats(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Game operations                                                     */
/* ------------------------------------------------------------------ */

async function writeGame(game: GameState): Promise<void> {
  await getGameStorage().set(keyFor(game.id), JSON.stringify(game));
  await upsertIndex(entryFromGame(game));
}

/** Record when a move was played — powers the real chess clocks. */
function stampMoveTime(game: GameState): GameState {
  const last = game.moves[game.moves.length - 1];
  if (last && !last.at) last.at = Date.now();
  return game;
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
  let next: GameState = stampMoveTime(res.game);
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
  let next: GameState = stampMoveTime(res.game);
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
  /** Signed-in account's player id (from the Supabase profile). */
  accountPlayerId?: string;
  scope?: "mine" | "watch" | "recent";
}): Promise<{ games?: GameState[]; live?: GameIndexEntry[]; recent?: GameIndexEntry[] }> {
  const entries = await readIndex();

  if (opts.scope === "mine" && opts.playerId) {
    // Include the signed-in account's games too (cross-device continuity:
    // a new device starts with a fresh guest id but keeps the account's
    // player id from its profile).
    const ids = new Set<string>([opts.playerId]);
    if (opts.accountPlayerId) ids.add(opts.accountPlayerId);
    const mine = entries.filter((e) => ids.has(e.creator) || ids.has(e.opponent));
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
