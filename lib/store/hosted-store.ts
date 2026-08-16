"use client";

import { getAuthIdentity, getGuestIdentity, getIdentityToken } from "@/lib/identity";
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
  live?: LiveGameEntry[];
  open?: GameIndexEntry[];
  recent?: GameIndexEntry[];
  players?: PlayerStats[];
  stats?: PlayerStats;
  myId?: string;
  error?: string;
}

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
        const key = JSON.stringify(game);
        if (this.lastState.get(id) !== key) {
          this.lastState.set(id, key);
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
      }
    };
  }

  getMyPlayerId(): string {
    return getMyPlayerId();
  }

  /* ------------------------------------------------------------------ */
  /* Platform data (real games / stats from the server store)            */
  /* ------------------------------------------------------------------ */

  async listMine(): Promise<GameState[]> {
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
    return data.games ?? [];
  }

  async listWatch(): Promise<{
    live: LiveGameEntry[];
    open: GameIndexEntry[];
    recent: GameIndexEntry[];
  }> {
    const data = await api("/api/hosted/games?scope=watch");
    return {
      live: data.live ?? [],
      open: data.open ?? [],
      recent: data.recent ?? [],
    };
  }

  async listRecent(): Promise<GameState[]> {
    const data = await api("/api/hosted/games?scope=recent");
    return data.games ?? [];
  }

  async leaderboard(): Promise<PlayerStats[]> {
    const data = await api("/api/hosted/leaderboard");
    return data.players ?? [];
  }

  async myProfile(): Promise<{ stats: PlayerStats; games: GameState[] }> {
    const data = await api(
      `/api/hosted/players/me?playerId=${encodeURIComponent(getMyPlayerId())}`,
    );
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
    };
  }
}
