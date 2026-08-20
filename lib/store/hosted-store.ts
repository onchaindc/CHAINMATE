"use client";

import { getAuthIdentity, getGuestIdentity, getIdentityToken } from "@/lib/identity";
import { isStaleGameState } from "@/lib/types";
import type {
  AiDifficulty,
  CreateGameOptions,
  GameIndexEntry,
  GameState,
  GameStore,
  LiveGameEntry,
  PlayerStats,
} from "@/lib/types";

/**
 * Shared multiplayer store. Game state lives in the server store (Vercel KV /
 * Upstash Redis when configured, otherwise the built-in file store) and this
 * store talks to /api/hosted/games — so two players on different devices can
 * join the same game. Live updates come from polling; a move is typically
 * visible to the opponent within ~2s.
 */

const POLL_MS = 2000;

interface ApiResponse {
  game?: GameState;
  games?: GameState[];
  /** Challenges waiting on my answer (/api/challenges). */
  challenges?: GameState[];
  live?: LiveGameEntry[];
  open?: GameIndexEntry[];
  recent?: GameIndexEntry[];
  /** Leaderboard rows (array) OR the per-game player display map. */
  players?: PlayerStats[] | Record<string, PlayerInfo>;
  stats?: PlayerStats;
  myId?: string;
  error?: string;
  status?: "matched" | "waiting";
  player?: PublicPlayer;
  friendship?: "none" | "requested" | "incoming" | "friends";
  friends?: PlayerStats[];
  incoming?: PlayerStats[];
  playersSearch?: SearchPlayerResult[];
  ok?: boolean;
}

/** Display info for one player, as served by the games/profile APIs. */
export interface PlayerInfo {
  id: string;
  name?: string;
  rating?: number;
  /** ISO country code when the player set one (for flags). */
  country?: string;
  isAi?: boolean;
}

/** A player's public profile (as served by /api/players/[username]). */
export interface PublicPlayer {
  playerId: string;
  username: string;
  isGuest: boolean;
  country: string | null;
  rating: number;
  peakRating: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  currentStreak: number;
  bestStreak: number;
  createdAt: string;
}

/** One row from the username search. */
export interface SearchPlayerResult {
  player_id: string;
  username: string;
  is_guest: boolean;
  rating: number;
  country: string | null;
  games: number;
}

export type SeekResult =
  | { status: "matched"; game: GameState }
  | { status: "waiting" };

export type FriendshipAction = "request" | "accept" | "decline" | "remove";

function getMyPlayerId(): string {
  // Persistent per-device identity (lib/identity.ts): the same player on
  // every refresh and tab. Signed-in players play under their account id, so
  // games stay attached to the account across devices.
  return getAuthIdentity()?.playerId ?? getGuestIdentity().playerId;
}

async function api(path: string, init?: RequestInit): Promise<ApiResponse> {
  const token = getIdentityToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as ApiResponse;
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export class HostedGameStore implements GameStore {
  private listeners = new Map<string, Set<(state: GameState) => void>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private lastState = new Map<string, string>();
  /** Last snapshot handed to subscribers, so stale poll results can be dropped. */
  private lastGame = new Map<string, GameState>();

  async createGame(options?: CreateGameOptions): Promise<GameState> {
    const data = await api("/api/hosted/games", {
      method: "POST",
      body: JSON.stringify({
        playerId: getMyPlayerId(),
        timeControl: options?.timeControl,
        visibility: options?.visibility,
      }),
    });
    if (!data.game) throw new Error("Failed to create game");
    return data.game;
  }

  async createAiGame(_difficulty?: AiDifficulty): Promise<GameState> {
    throw new Error("Single-player games run in the built-in offline store");
  }

  async joinGame(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "join", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Failed to join game");
    return data.game;
  }

  async getGame(id: string): Promise<GameState | null> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`);
    return data.game ?? null;
  }

  async submitMove(
    id: string,
    from: string,
    to: string,
    promotion?: string,
  ): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({
        action: "move",
        playerId: getMyPlayerId(),
        move: { from, to, promotion },
      }),
    });
    if (!data.game) throw new Error("Move failed");
    return data.game;
  }

  async submitAiMove(): Promise<GameState> {
    throw new Error("AI games run in the built-in offline store");
  }

  async resign(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "resign", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Resignation failed");
    return data.game;
  }

  async offerDraw(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "draw-offer", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Draw offer failed");
    return data.game;
  }

  async respondDraw(id: string, accept: boolean): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({
        action: "draw-respond",
        playerId: getMyPlayerId(),
        accept,
      }),
    });
    if (!data.game) throw new Error("Draw response failed");
    return data.game;
  }

  async abort(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "abort", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Abort failed");
    return data.game;
  }

  async rematch(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "rematch", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Rematch failed");
    return data.game;
  }

  async resolveTimeout(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "timeout", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Failed to settle the clock");
    return data.game;
  }

  async generateSummary(id: string): Promise<GameState> {
    const data = await api(`/api/hosted/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "summary", playerId: getMyPlayerId() }),
    });
    if (!data.game) throw new Error("Summary generation failed");
    return data.game;
  }

  subscribe(id: string, callback: (state: GameState) => void): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(callback);

    const poll = async () => {
      try {
        const game = await this.getGame(id);
        if (!game) return;
        // Two polls can be in flight at once, so a slow response can land after
        // a fast one. Dropping the older snapshot here keeps the dedup key
        // moving forwards — otherwise it would rewind and then re-fire the
        // current state as if it were news.
        const previous = this.lastGame.get(id);
        if (previous && isStaleGameState(previous, game)) return;
        const key = JSON.stringify(game);
        if (this.lastState.get(id) !== key) {
          this.lastState.set(id, key);
          this.lastGame.set(id, game);
          for (const cb of this.listeners.get(id) ?? []) cb(game);
        }
      } catch {
        // transient network errors — keep polling
      }
    };

    void poll();
    if (!this.timers.has(id)) {
      this.timers.set(id, setInterval(poll, POLL_MS));
    }

    return () => {
      this.listeners.get(id)?.delete(callback);
      if ((this.listeners.get(id)?.size ?? 0) === 0) {
        const timer = this.timers.get(id);
        if (timer) {
          clearInterval(timer);
          this.timers.delete(id);
        }
        this.lastState.delete(id);
        this.lastGame.delete(id);
      }
    };
  }

  getMyPlayerId(): string {
    return getMyPlayerId();
  }

  /* ------------------------------------------------------------------ */
  /* Platform data (real games / stats from the server store)            */
  /* ------------------------------------------------------------------ */

  async listMine(): Promise<{ games: GameState[]; players: Record<string, PlayerInfo> }> {
    const auth = getAuthIdentity();
    const params = new URLSearchParams({
      scope: "mine",
      playerId: getMyPlayerId(),
    });
    // Include the signed-in account's games (cross-device continuity).
    if (auth && auth.playerId && auth.playerId !== getMyPlayerId()) {
      params.set("accountPlayerId", auth.playerId);
    }
    const data = await api(`/api/hosted/games?${params.toString()}`);
    const players = (data.players ?? {}) as Record<string, PlayerInfo>;
    return { games: data.games ?? [], players };
  }

  async listWatch(): Promise<{
    live: LiveGameEntry[];
    open: GameIndexEntry[];
    recent: GameIndexEntry[];
    players: Record<string, PlayerInfo>;
  }> {
    const data = await api("/api/hosted/games?scope=watch");
    return {
      live: data.live ?? [],
      open: data.open ?? [],
      recent: data.recent ?? [],
      // `open` and `recent` are bare index entries (player ids, no names), so
      // the caller needs this map to show real usernames on those rows.
      players: (data.players ?? {}) as Record<string, PlayerInfo>,
    };
  }

  async listRecent(): Promise<{
    games: GameState[];
    players: Record<string, PlayerInfo>;
  }> {
    const data = await api("/api/hosted/games?scope=recent");
    return {
      games: data.games ?? [],
      players: (data.players ?? {}) as Record<string, PlayerInfo>,
    };
  }

  async leaderboard(): Promise<PlayerStats[]> {
    const data = await api("/api/hosted/leaderboard");
    return (data.players as PlayerStats[] | undefined) ?? [];
  }

  async myProfile(): Promise<{
    stats: PlayerStats;
    games: GameState[];
    players: Record<string, PlayerInfo>;
  }> {
    const data = await api(
      `/api/hosted/players/me?playerId=${encodeURIComponent(getMyPlayerId())}`,
    );
    const players = (data.players ?? {}) as Record<string, PlayerInfo>;
    return {
      stats:
        data.stats ??
        {
          playerId: getMyPlayerId(),
          rating: 1200,
          peakRating: 1200,
          wins: 0,
          losses: 0,
          draws: 0,
          games: 0,
          currentStreak: 0,
          bestStreak: 0,
          ratingHistory: [],
          achievements: [],
          updatedAt: 0,
        },
      games: data.games ?? [],
      players,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Matchmaking — find a live opponent (real pairing, not a fake queue)  */
  /* ------------------------------------------------------------------ */

  /** Register as seeking, or get matched instantly when a partner waits. */
  async seekMatch(timeControl?: string): Promise<SeekResult> {
    const data = await api("/api/matchmaking/seek", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId(), timeControl }),
    });
    return data as SeekResult;
  }

  /** Check whether a pairing appeared since the last seek call. */
  async pollSeek(timeControl?: string): Promise<SeekResult> {
    const params = new URLSearchParams({ playerId: getMyPlayerId() });
    // Sent so the server can put the player back in the pool if they dropped
    // out of it — otherwise they'd poll forever against an empty registration.
    if (timeControl) params.set("timeControl", timeControl);
    const data = await api(`/api/matchmaking/status?${params.toString()}`);
    return data as SeekResult;
  }

  /** Leave the seek pool (user cancelled or gave up). */
  async cancelSeek(): Promise<void> {
    await api("/api/matchmaking/cancel", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId() }),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Direct challenges — invite one specific player                       */
  /* ------------------------------------------------------------------ */

  /** Challenge a specific player. Returns the pending game to wait in. */
  async challenge(opponentId: string, timeControl?: string): Promise<GameState> {
    const data = await api("/api/challenges", {
      method: "POST",
      body: JSON.stringify({
        playerId: getMyPlayerId(),
        opponentId,
        timeControl,
        action: "create",
      }),
    });
    if (!data.game) throw new Error("Could not send the challenge");
    return data.game;
  }

  /** Challenges waiting on my answer, with the challenger's display info. */
  async listChallenges(): Promise<{
    challenges: GameState[];
    players: Record<string, PlayerInfo>;
  }> {
    const data = await api(
      `/api/challenges?playerId=${encodeURIComponent(getMyPlayerId())}`,
    );
    return {
      challenges: data.challenges ?? [],
      players: (data.players ?? {}) as Record<string, PlayerInfo>,
    };
  }

  /** Accept a challenge — the game starts immediately. */
  async acceptChallenge(gameId: string): Promise<GameState> {
    const data = await api("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId(), gameId, action: "accept" }),
    });
    if (!data.game) throw new Error("Could not accept the challenge");
    return data.game;
  }

  /** Decline a challenge — the game is aborted, nothing is rated. */
  async declineChallenge(gameId: string): Promise<void> {
    await api("/api/challenges", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId(), gameId, action: "decline" }),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Player search, public profiles & friends                             */
  /* ------------------------------------------------------------------ */

  /** Search ChainMate accounts by username fragment. */
  async searchPlayers(q: string): Promise<SearchPlayerResult[]> {
    const data = await api(`/api/players/search?q=${encodeURIComponent(q)}`);
    return data.playersSearch ?? [];
  }

  /** Load another player's public profile (+ friendship status with me). */
  async publicProfile(username: string): Promise<{
    player: PublicPlayer;
    stats: PlayerStats;
    games: GameState[];
    players: Record<string, PlayerInfo>;
    friends: PlayerStats[];
    friendship: "none" | "requested" | "incoming" | "friends";
  }> {
    const params = new URLSearchParams({ viewer: getMyPlayerId() });
    const data = await api(`/api/players/${encodeURIComponent(username)}?${params}`);
    if (!data.player) throw new Error("Player not found");
    return {
      player: data.player,
      stats:
        data.stats ??
        ({
          playerId: data.player.playerId,
          rating: data.player.rating,
          peakRating: data.player.peakRating,
          wins: data.player.wins,
          losses: data.player.losses,
          draws: data.player.draws,
          games: data.player.games,
          currentStreak: data.player.currentStreak,
          bestStreak: data.player.bestStreak,
          ratingHistory: [],
          achievements: [],
          updatedAt: 0,
        } as PlayerStats),
      games: data.games ?? [],
      players: (data.players ?? {}) as Record<string, PlayerInfo>,
      friends: data.friends ?? [],
      friendship: data.friendship ?? "none",
    };
  }

  /** My accepted friends + incoming requests. */
  async friends(): Promise<{ friends: PlayerStats[]; incoming: PlayerStats[] }> {
    const data = await api(
      `/api/friends?playerId=${encodeURIComponent(getMyPlayerId())}`,
    );
    return { friends: data.friends ?? [], incoming: data.incoming ?? [] };
  }

  /** Send / accept / decline / remove a friendship with another player. */
  async friendAction(action: FriendshipAction, otherId: string): Promise<void> {
    await api("/api/friends", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId(), otherId, action }),
    });
  }

  /** Set (or clear) the optional country flag on my profile. */
  async setCountry(country: string | null): Promise<PlayerStats> {
    const data = await api("/api/players/me", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId(), country }),
    });
    if (!data.stats) throw new Error("Failed to update profile");
    return data.stats;
  }
}
