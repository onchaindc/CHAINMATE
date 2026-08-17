import { abortGame, applyMoveToGame, joinPlayerToGame, offerDrawToGame, resignPlayerFromGame, respondToDrawOffer } from "@/lib/game-logic";
import { computeClocks } from "@/lib/clocks";
import { getGameStorage } from "@/lib/server/storage";
import { earnedAchievements, earnedCodes, type AchievementContext } from "@/lib/achievements";
import { buildRuleSummary } from "@/lib/summary";
import { glickoUpdate, START_RATING, START_RD } from "@/lib/ratings";
import { supabaseConfigured } from "@/lib/supabase/config";
import {
  gameSnapshotById,
  profileForPlayerId,
  recentGameSnapshots,
  setPlayerCountry,
  upsertAchievements,
  upsertGameRecord,
  upsertGameSnapshot,
  upsertProfiles,
} from "@/lib/supabase/db";
import {
  AI_PLAYER_ID,
  isGameOver,
  type CreateGameOptions,
  type GameIndexEntry,
  type GameState,
  type LiveGameEntry,
  type LivePlayerInfo,
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
const LIVE_KEY = "chainmate:index:live:v1";
const STATS_PREFIX = "chainmate:player:";
const INDEX_MAX = 400;
const LEADERBOARD_MAX = 100;
const LIVE_MAX = 24;

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
  if (raw) {
    try {
      return JSON.parse(raw) as GameIndexEntry[];
    } catch {
      // corrupted — rebuild from the database below
    }
  }
  // Fast store miss (cold start / storage reset): rebuild the index from the
  // durable Supabase snapshots so Games / Watch / homepage keep working.
  if (supabaseConfigured()) {
    try {
      const games = await recentGameSnapshots(INDEX_MAX);
      if (games.length > 0) {
        const entries = games.map(entryFromGame);
        await getGameStorage().set(INDEX_KEY, JSON.stringify(entries));
        return entries;
      }
    } catch {
      // Best-effort — Supabase problems never break the game flow.
    }
  }
  return [];
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
/* Live-game registry                                                  */
/* ------------------------------------------------------------------ */

/**
 * The canonical broadcast feed for Watch. Every game that enters LIVE state
 * is registered here automatically (on the same write that starts it) and is
 * removed the moment it ends — so watchers always see real, current matches.
 * The feed is derived from real game state; nothing is hardcoded.
 */
interface LiveRegistryEntry {
  id: string;
  creator: string;
  opponent: string;
  visibility: "public" | "private";
  timeControl?: string;
  moveCount: number;
  startedAt?: number;
  updatedAt: number;
}

async function readLiveRegistry(): Promise<LiveRegistryEntry[]> {
  const raw = await getGameStorage().get(LIVE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as LiveRegistryEntry[];
    } catch {
      // corrupted — rebuild from the database below
    }
  }
  // Fast store miss: re-derive the live feed from durable active snapshots.
  if (supabaseConfigured()) {
    try {
      const games = await recentGameSnapshots(LIVE_MAX, "active");
      if (games.length > 0) {
        const entries: LiveRegistryEntry[] = games.map((g) => ({
          id: g.id,
          creator: g.creator,
          opponent: g.opponent,
          visibility: g.visibility === "private" ? "private" : "public",
          timeControl: g.timeControl,
          moveCount: g.moves.length,
          startedAt: g.startedAt,
          updatedAt: g.updatedAt ?? Date.now(),
        }));
        await writeLiveRegistry(entries);
        return entries;
      }
    } catch {
      // Best-effort
    }
  }
  return [];
}

async function writeLiveRegistry(entries: LiveRegistryEntry[]): Promise<void> {
  await getGameStorage().set(LIVE_KEY, JSON.stringify(entries.slice(0, LIVE_MAX)));
}

async function upsertLive(game: GameState): Promise<void> {
  const entries = await readLiveRegistry();
  const entry: LiveRegistryEntry = {
    id: game.id,
    creator: game.creator,
    opponent: game.opponent,
    visibility: game.visibility === "private" ? "private" : "public",
    timeControl: game.timeControl,
    moveCount: game.moves.length,
    startedAt: game.startedAt,
    updatedAt: game.updatedAt ?? Date.now(),
  };
  const idx = entries.findIndex((e) => e.id === game.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.unshift(entry);
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeLiveRegistry(entries);
}

async function removeLive(id: string): Promise<void> {
  const entries = await readLiveRegistry();
  if (!entries.some((e) => e.id === id)) return;
  await writeLiveRegistry(entries.filter((e) => e.id !== id));
}

/** Real display info for one player in the live feed (username + rating). */
async function livePlayerInfo(playerId: string): Promise<LivePlayerInfo> {
  if (playerId === AI_PLAYER_ID) {
    return { id: playerId, name: "ChainMate AI", isAi: true };
  }
  if (!playerId) {
    return { id: playerId, name: "Waiting…" };
  }
  const stats = await getPlayerStats(playerId);
  return {
    id: playerId,
    name: stats.username,
    rating: stats.rating,
    country: stats.country,
  };
}

async function enrichLive(entries: LiveRegistryEntry[]): Promise<LiveGameEntry[]> {
  const out: LiveGameEntry[] = [];
  for (const e of entries) {
    const [creator, opponent] = await Promise.all([
      livePlayerInfo(e.creator),
      livePlayerInfo(e.opponent),
    ]);
    out.push({
      id: e.id,
      creator,
      opponent,
      timeControl: e.timeControl,
      moveCount: e.moveCount,
      startedAt: e.startedAt,
      updatedAt: e.updatedAt,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Player stats + leaderboard                                          */
/* ------------------------------------------------------------------ */

function defaultStats(playerId: string): PlayerStats {
  return {
    playerId,
    rating: START_RATING,
    rd: START_RD,
    lastPlayedAt: null,
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
  if (raw) {
    try {
      return JSON.parse(raw) as PlayerStats;
    } catch {
      // corrupted record — fall through to the database
    }
  }
  // KV miss (fresh instance, new device): fall back to the persisted
  // Supabase profile so a real rating is never silently reset to 1200.
  if (supabaseConfigured()) {
    try {
      const row = await profileForPlayerId(playerId);
      if (row) {
        const stats: PlayerStats = {
          playerId,
          username: row.username,
          isGuest: row.is_guest,
          country: row.country ?? undefined,
          rating: row.rating,
          rd: row.rd ?? START_RD,
          lastPlayedAt: row.last_played_at ?? null,
          peakRating: row.peak_rating,
          wins: row.wins,
          losses: row.losses,
          draws: row.draws,
          games: row.games,
          currentStreak: row.current_streak,
          bestStreak: row.best_streak,
          ratingHistory: [],
          achievements: [],
          updatedAt: new Date(row.updated_at).getTime() || Date.now(),
        };
        // Warm the fast-path cache so subsequent reads are instant.
        await getGameStorage().set(
          `${STATS_PREFIX}${playerId}`,
          JSON.stringify(stats),
        );
        return stats;
      }
    } catch {
      // Supabase problems must never break chess — fall back to defaults.
    }
  }
  return defaultStats(playerId);
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
  // Aborted games never happened — no rating impact for either side.
  if (next.status === "aborted") return;
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

  // Glicko-1: both sides update atomically; the size of each change depends
  // on the opponent's rating and both players' rating deviation (confidence).
  // New/inactive players (high RD) move more; established players barely budge.
  const now = Date.now();
  const result = glickoUpdate(
    { rating: s1.rating, rd: s1.rd ?? START_RD, lastPlayedAt: s1.lastPlayedAt ?? null },
    { rating: s2.rating, rd: s2.rd ?? START_RD, lastPlayedAt: s2.lastPlayedAt ?? null },
    score1,
    now,
  );
  const rating1 = result.a.rating;
  const rating2 = result.b.rating;
  const rd1 = result.a.rd;
  const rd2 = result.b.rd;

  const applyStats = (
    s: PlayerStats,
    score: number,
    before: number,
    oppBefore: number,
    rating: number,
    rd: number,
  ) => {
    s.rating = rating;
    s.rd = rd;
    s.lastPlayedAt = now;
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

  applyStats(s1, score1, ratingBefore1, ratingBefore2, rating1, rd1);
  applyStats(s2, score2, ratingBefore2, ratingBefore1, rating2, rd2);

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
  update: { username?: string; isGuest?: boolean; country?: string | null },
): Promise<PlayerStats> {
  const stats = await getPlayerStats(playerId);
  const next: PlayerStats = {
    ...stats,
    username: update.username ?? stats.username,
    isGuest: update.isGuest ?? stats.isGuest,
    country:
      update.country !== undefined
        ? (update.country ?? undefined)
        : stats.country,
    updatedAt: Date.now(),
  };
  await writeStats(next);
  return next;
}

/**
 * Set (or clear) the player's optional country — display-only, mirrored to
 * the persistent Supabase profile so it survives storage resets and shows
 * on other devices.
 */
export async function updatePlayerCountry(
  playerId: string,
  country: string | null,
): Promise<PlayerStats> {
  const normalized = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
  const stats = await updatePlayerIdentity(playerId, { country: normalized });
  if (supabaseConfigured()) {
    try {
      await setPlayerCountry(playerId, normalized);
    } catch {
      // best-effort — country is decorative, never blocks anything
    }
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/* Game operations                                                     */
/* ------------------------------------------------------------------ */

async function writeGame(game: GameState): Promise<void> {
  await getGameStorage().set(keyFor(game.id), JSON.stringify(game));
  await upsertIndex(entryFromGame(game));
  // Keep the live broadcast feed in sync with real game lifecycle: register
  // on LIVE, update with every move, remove the moment the game ends.
  if (game.status === "active") {
    await upsertLive(game);
  } else {
    await removeLive(game.id);
  }
  // Durability: mirror the full state to Supabase so a mid-game cold start
  // or storage reset can never turn into "Game not found" (restored in
  // getHostedGame). Best-effort — the game store stays the source of truth.
  if (supabaseConfigured()) {
    try {
      await upsertGameSnapshot(game);
    } catch {
      // Supabase hiccups must never break a chess move.
    }
  }
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
    // Default: public. Live games are broadcast to Watch automatically —
    // "private" is an explicit opt-out for players who want an invite-only
    // match. The setting never gates what the server records; it only
    // controls discoverability in the Watch feed.
    visibility: options.visibility === "private" ? "private" : "public",
    createdAt: now,
    updatedAt: now,
  };
  await writeGame(game);
  return game;
}

/**
 * Resolve a flag fall: if the side to move has no time left, the game ends
 * (status "timeout", the other side wins). Called lazily on every read and
 * mutation, so the first poll after the clock hits zero settles the game.
 * Deterministic from the recorded move timestamps; no-op for games without
 * clocks or without move timestamps.
 */
async function resolveTimeout(game: GameState): Promise<GameState> {
  if (game.status !== "active" || !game.timeControl || !game.startedAt) return game;
  const clocks = computeClocks(game, Date.now());
  if (!clocks) return game;

  const turn = game.fen.split(" ")[1] ?? "w";
  const flagged = turn === "w" ? clocks.white : clocks.black;
  if (flagged > 0) return game;

  const winner = turn === "w" ? game.opponent : game.creator;
  const now = Date.now();
  const next: GameState = {
    ...game,
    status: "timeout",
    winner,
    endedAt: now,
    updatedAt: now,
    drawOffer: undefined,
    summary: game.summary || buildRuleSummary(game),
    commentary: [
      ...game.commentary,
      {
        move: "",
        side: turn === "w" ? "white" : "black",
        text: `${turn === "w" ? "White" : "Black"} lost on time.`,
        source: "chain",
      },
    ],
  };
  await applyRatingsIfFinished(game, next);
  await writeGame(next);
  return next;
}

export async function getHostedGame(id: string): Promise<GameState | null> {
  const raw = await getGameStorage().get(keyFor(id));
  let game: GameState | null = null;
  if (raw) {
    try {
      game = JSON.parse(raw) as GameState;
    } catch {
      game = null;
    }
  }
  if (!game) {
    // Fast store miss (cold start, instance switch, storage reset): restore
    // the game from the durable Supabase snapshot and re-seed local storage
    // so the match keeps playing exactly where it left off.
    if (supabaseConfigured()) {
      try {
        game = await gameSnapshotById(id);
        if (game) {
          await writeGame(game);
        }
      } catch {
        // Best-effort
      }
    }
  }
  if (!game) return null;
  // A flag fall may have happened since the last write — settle it now.
  return resolveTimeout(game);
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

export async function offerDrawHostedGame(id: string, playerId: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = offerDrawToGame(game, playerId);
  if (!res.ok) throw new Error(res.error);
  const next: GameState = { ...res.game, updatedAt: Date.now() };
  await writeGame(next);
  return next;
}

export async function respondHostedDraw(
  id: string,
  playerId: string,
  accept: boolean,
): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = respondToDrawOffer(game, playerId, accept);
  if (!res.ok) throw new Error(res.error);
  let next: GameState = { ...res.game, updatedAt: Date.now() };
  if (isGameOver(next.status) && !next.endedAt) {
    next = {
      ...next,
      endedAt: Date.now(),
      updatedAt: Date.now(),
      summary: next.summary || buildRuleSummary(next),
    };
    await applyRatingsIfFinished(game, next);
  }
  await writeGame(next);
  return next;
}

export async function abortHostedGame(id: string, playerId: string): Promise<GameState> {
  const game = await getHostedGame(id);
  if (!game) throw new Error("Game not found");
  const res = abortGame(game, playerId);
  if (!res.ok) throw new Error(res.error);
  const now = Date.now();
  const next: GameState = {
    ...res.game,
    endedAt: now,
    updatedAt: now,
    // Aborted games are never rated — just record the outcome.
    summary: res.game.summary || buildRuleSummary(res.game),
  };
  await writeGame(next);
  return next;
}

/**
 * One-click rematch: a fresh match against the same opponent with the same
 * time control, colours swapped, starting immediately. The opponent can
 * abort it (no rating impact) before the first move if they don't want it.
 */
export async function rematchHostedGame(prevId: string, playerId: string): Promise<GameState> {
  const prev = await getHostedGame(prevId);
  if (!prev) throw new Error("Game not found");
  if (!isGameOver(prev.status)) throw new Error("The previous game is still in progress");
  if (prev.creator !== playerId && prev.opponent !== playerId) {
    throw new Error("You were not a player in this game");
  }
  const other = prev.creator === playerId ? prev.opponent : prev.creator;
  if (!other || other === AI_PLAYER_ID) {
    throw new Error("Rematch requires a human opponent");
  }
  const now = Date.now();
  const id = `hosted_${randomHex(6)}`;
  const game: GameState = {
    id,
    creator: playerId,
    opponent: other,
    status: "active",
    winner: "",
    fen: START_FEN,
    moves: [],
    commentary: [],
    summary: "",
    backend: "hosted",
    timeControl: prev.timeControl,
    visibility: prev.visibility === "private" ? "private" : "public",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  await writeGame(game);
  return game;
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

/**
 * Settle the live registry against real game state: drop games that ended
 * (or vanished) and refresh move counts, so the Watch feed never shows a
 * game that a flag fall already finished. Runs on every watch poll.
 */
async function settleLiveRegistry(): Promise<void> {
  const entries = await readLiveRegistry();
  if (entries.length === 0) return;
  const kept: LiveRegistryEntry[] = [];
  let changed = false;
  for (const e of entries) {
    const game = await getHostedGame(e.id);
    if (!game || isGameOver(game.status)) {
      changed = true; // settled or gone — no longer broadcastable
      continue;
    }
    if (game.moves.length !== e.moveCount || (game.updatedAt ?? 0) !== e.updatedAt) {
      changed = true;
      e.moveCount = game.moves.length;
      e.updatedAt = game.updatedAt ?? e.updatedAt;
    }
    kept.push(e);
  }
  if (changed) await writeLiveRegistry(kept);
}

/** Display info (username + rating) for a set of player ids. */
async function playerNamesFor(ids: string[]): Promise<Record<string, LivePlayerInfo>> {
  const out: Record<string, LivePlayerInfo> = {};
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || id === AI_PLAYER_ID || seen.has(id)) continue;
    seen.add(id);
    out[id] = await livePlayerInfo(id);
  }
  return out;
}

/** Real list data for Games / Watch / homepage. */
export async function listHostedGames(opts: {
  playerId?: string;
  /** Signed-in account's player id (from the Supabase profile). */
  accountPlayerId?: string;
  scope?: "mine" | "watch" | "recent";
}): Promise<{
    games?: GameState[];
    live?: LiveGameEntry[];
    open?: GameIndexEntry[];
    recent?: GameIndexEntry[];
    players?: Record<string, LivePlayerInfo>;
  }> {
  const entries = await readIndex();

  if (opts.scope === "mine" && opts.playerId) {
    // Include the signed-in account's games too (cross-device continuity:
    // a new device starts with a fresh guest id but keeps the account's
    // player id from its profile).
    const ids = new Set<string>([opts.playerId]);
    if (opts.accountPlayerId) ids.add(opts.accountPlayerId);
    const mine = entries.filter((e) => ids.has(e.creator) || ids.has(e.opponent));
    const games = await fetchGames(mine, 25);
    const players = await playerNamesFor(
      games.flatMap((g) => [g.creator, g.opponent]),
    );
    return { games, players };
  }

  if (opts.scope === "watch") {
    // Settle any flag falls first so the feed only shows real live games,
    // then serve the registry (auto-published on start, removed on end).
    // Explicitly private matches stay out of the broadcast.
    await settleLiveRegistry();
    const registry = await readLiveRegistry();
    const live = await enrichLive(
      registry.filter((e) => e.visibility !== "private"),
    );
    // Open games: public matches still waiting for an opponent (joinable).
    const open = entries.filter(
      (e) => e.visibility === "public" && e.status === "waiting",
    );
    const done = entries.filter((e) => isGameOver(e.status));
    return {
      live: live.slice(0, LIVE_MAX),
      open: open.slice(0, 8),
      recent: done.slice(0, 12),
    };
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
  players: Record<string, LivePlayerInfo>;
}> {
  const stats = await getPlayerStats(playerId);
  const entries = await readIndex();
  const mine = entries.filter(
    (e) => e.creator === playerId || e.opponent === playerId,
  );
  const games = await fetchGames(mine, 15);
  const players = await playerNamesFor(
    games.flatMap((g) => [g.creator, g.opponent]),
  );
  return { stats, games, players };
}

/* ------------------------------------------------------------------ */
/* Matchmaking — live seek registry, rating-proximity pairing          */
/* ------------------------------------------------------------------ */

const SEEKERS_KEY = "chainmate:index:seekers:v1";
const SEEK_RESULT_PREFIX = "chainmate:seeker:result:";
/** Stale seekers are dropped after 5 minutes so the pool never rots. */
const SEEKER_TTL_MS = 5 * 60 * 1000;

export interface SeekerEntry {
  playerId: string;
  rating: number;
  timeControl?: string;
  seekedAt: number;
}

export type SeekResult =
  | { status: "matched"; game: GameState }
  | { status: "waiting" };

async function readSeekers(): Promise<SeekerEntry[]> {
  const raw = await getGameStorage().get(SEEKERS_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as SeekerEntry[];
    const now = Date.now();
    return list.filter((s) => now - s.seekedAt < SEEKER_TTL_MS);
  } catch {
    return [];
  }
}

async function writeSeekers(entries: SeekerEntry[]): Promise<void> {
  await getGameStorage().set(SEEKERS_KEY, JSON.stringify(entries));
}

/**
 * Register the player as actively seeking, then try to pair them with the
 * closest compatible seeker. Pairing uses rating proximity: same time
 * control preferred, closest rating wins, and the match is only made when
 * the gap is reasonable for the player's confidence (provisional players
 * match almost anyone; established players pair within ~300 points). The
 * player who waited longer plays White. When a pair is found, a real rated
 * hosted game starts immediately — nothing is faked or staged.
 */
export async function seekMatch(
  playerId: string,
  timeControl?: string,
): Promise<SeekResult> {
  const now = Date.now();
  const seekers = await readSeekers();
  const others = seekers.filter((s) => s.playerId !== playerId);
  const me = await getPlayerStats(playerId);

  const candidates = others.filter(
    (s) => !timeControl || !s.timeControl || s.timeControl === timeControl,
  );
  let best: SeekerEntry | null = null;
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(c.rating - me.rating);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  const maxDiff = (me.rd ?? START_RD) >= 250 ? 500 : 300;

  if (best && bestDiff <= maxDiff) {
    const game: GameState = {
      id: `hosted_${randomHex(6)}`,
      creator: best.playerId, // White — waited longer
      opponent: playerId, // Black
      status: "active",
      winner: "",
      fen: START_FEN,
      moves: [],
      commentary: [],
      summary: "",
      backend: "hosted",
      timeControl: best.timeControl ?? timeControl,
      visibility: "public",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    await writeGame(game);
    // Both players leave the pool; the earlier seeker picks the game up
    // through pollSeek (their seek call already returned "waiting").
    await writeSeekers(others.filter((s) => s.playerId !== best!.playerId));
    await getGameStorage().set(
      `${SEEK_RESULT_PREFIX}${best.playerId}`,
      JSON.stringify({ id: game.id }),
    );
    return { status: "matched", game };
  }

  await writeSeekers([...others, { playerId, rating: me.rating, timeControl, seekedAt: now }]);
  return { status: "waiting" };
}

/**
 * Check whether a pairing was created for this player (the other side's
 * seek call may have matched while this player's poll was in flight), and
 * recover from the two-simultaneous-seek race by re-entering the pool and
 * trying to pair again — so two players who started searching at the same
 * instant still get matched on the next poll.
 */
export async function pollSeek(playerId: string): Promise<SeekResult> {
  const raw = await getGameStorage().get(`${SEEK_RESULT_PREFIX}${playerId}`);
  if (raw) {
    try {
      const { id } = JSON.parse(raw) as { id: string };
      const game = await getHostedGame(id);
      if (game) {
        await getGameStorage().delete(`${SEEK_RESULT_PREFIX}${playerId}`);
        return { status: "matched", game };
      }
    } catch {
      // corrupted result — treat as still waiting
    }
  }
  // Still registered? Re-seek with the same time control (re-entering the
  // pool is idempotent) so a simultaneous-seek race still ends in a match.
  const seekers = await readSeekers();
  const mine = seekers.find((s) => s.playerId === playerId);
  if (mine) return seekMatch(playerId, mine.timeControl);
  return { status: "waiting" };
}

/** Leave the seek pool (user cancelled or found an opponent elsewhere). */
export async function cancelSeek(playerId: string): Promise<void> {
  const seekers = await readSeekers();
  await writeSeekers(seekers.filter((s) => s.playerId !== playerId));
  await getGameStorage().delete(`${SEEK_RESULT_PREFIX}${playerId}`).catch(() => {});
}
