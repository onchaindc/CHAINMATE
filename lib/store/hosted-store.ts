"use client";

import { HOSTED_PLAYER_KEY } from "@/lib/config";
import type { AiDifficulty, GameState, GameStore } from "@/lib/types";
import { randomHex } from "@/lib/utils";

/**
 * Shared multiplayer store. Game state lives in Vercel KV (server-side) and
 * this store talks to /api/hosted/games — so two players on different
 * devices can join the same game. Live updates come from polling; a move is
 * typically visible to the opponent within ~2s.
 */

const POLL_MS = 2000;

interface ApiResponse {
  game?: GameState;
  myId?: string;
  error?: string;
}

function getMyPlayerId(): string {
  // sessionStorage keeps a per-tab identity (like the local store), so two
  // tabs of the same browser can join each other's game. The id survives a
  // refresh in the same tab, so players keep their side across reloads.
  const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null;
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const existing = store?.getItem(HOSTED_PLAYER_KEY);
  if (existing) return existing;
  const id = `0x${randomHex(20)}`;
  store?.setItem(HOSTED_PLAYER_KEY, id);
  return id;
}

async function api(path: string, init?: RequestInit): Promise<ApiResponse> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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

  async createGame(): Promise<GameState> {
    const data = await api("/api/hosted/games", {
      method: "POST",
      body: JSON.stringify({ playerId: getMyPlayerId() }),
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
}
