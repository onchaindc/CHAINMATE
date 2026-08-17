"use client";

import { getAuthIdentity, getGuestIdentity } from "@/lib/identity";
import type { CreateGameOptions, GameState, GameStore } from "@/lib/types";

/**
 * On-chain game store. Every write is signed server-side (see
 * lib/server/genlayer.ts) and state is read back from the contract.
 * Live updates come from polling get_game; on testnet a move typically
 * finalises in a few seconds (LLM-heavy calls longer).
 *
 * The server binds the game's White/Black to the browser identities that
 * created/joined it; moves and resignations send only our own identity — the
 * client never chooses a signing key (no caller-selected server key).
 */

const MY_ID_KEY = "chainmate:genlayer:my-id";
const POLL_MS = 2500;

/** The app identity the server bound this game's slot to. */
function myPlayerId(): string {
  return getAuthIdentity()?.playerId ?? getGuestIdentity().playerId;
}

interface ApiResponse {
  game?: GameState;
  myId?: string;
  error?: string;
}

function readLocal(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(key);
}

function writeLocal(key: string, value: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, value);
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

export class GenLayerGameStore implements GameStore {
  private listeners = new Map<string, Set<(state: GameState) => void>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private lastState = new Map<string, string>();

  async createGame(_options?: CreateGameOptions): Promise<GameState> {
    const data = await api("/api/games", {
      method: "POST",
      body: JSON.stringify({ playerId: myPlayerId() }),
    });
    if (!data.game) throw new Error("Failed to create game");
    if (data.myId) writeLocal(MY_ID_KEY, data.myId);
    return data.game;
  }

  async createAiGame(): Promise<GameState> {
    throw new Error("Single-player games run in the built-in offline store");
  }

  async joinGame(id: string): Promise<GameState> {
    const data = await api(`/api/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "join", playerId: myPlayerId() }),
    });
    if (!data.game) throw new Error("Failed to join game");
    if (data.myId) writeLocal(MY_ID_KEY, data.myId);
    return data.game;
  }

  async getGame(id: string): Promise<GameState | null> {
    const data = await api(`/api/games/${encodeURIComponent(id)}`);
    return data.game ?? null;
  }

  async submitMove(
    id: string,
    from: string,
    to: string,
    promotion?: string,
  ): Promise<GameState> {
    const data = await api(`/api/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({
        action: "move",
        playerId: myPlayerId(),
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
    const data = await api(`/api/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "resign", playerId: myPlayerId() }),
    });
    if (!data.game) throw new Error("Resignation failed");
    return data.game;
  }

  async offerDraw(): Promise<GameState> {
    throw new Error("Draw offers are not supported on-chain yet — resign or keep playing");
  }

  async respondDraw(): Promise<GameState> {
    throw new Error("Draw offers are not supported on-chain yet");
  }

  async abort(): Promise<GameState> {
    throw new Error("Aborting is not supported on-chain yet — resign instead");
  }

  async rematch(): Promise<GameState> {
    throw new Error("Rematch is not supported on-chain yet — start a new game");
  }

  async resolveTimeout(id: string): Promise<GameState> {
    const game = await this.getGame(id);
    if (!game) throw new Error("Game not found");
    return game;
  }

  async generateSummary(id: string): Promise<GameState> {
    const data = await api(`/api/games/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "summary" }),
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
    return readLocal(MY_ID_KEY) ?? "0x…";
  }
}
