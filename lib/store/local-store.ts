"use client";

import { applyMoveToGame, joinPlayerToGame, offerDrawToGame, resignPlayerFromGame, respondToDrawOffer } from "@/lib/game-logic";
import { chooseAiMove } from "@/lib/ai-engine";
import { computeClocks } from "@/lib/clocks";
import { LOCAL_GAME_PREFIX, LOCAL_PLAYER_KEY } from "@/lib/config";
import { buildRuleSummary } from "@/lib/summary";
import {
  AI_PLAYER_ID,
  isGameOver,
  type AiDifficulty,
  type CreateGameOptions,
  type GameState,
  type GameStore,
} from "@/lib/types";
import { START_FEN } from "@/lib/types";
import { randomHex } from "@/lib/utils";

/**
 * Built-in offline game store. Game state lives in localStorage and syncs
 * across tabs of the same browser via BroadcastChannel + storage events, so
 * two players on one machine can play a full game with zero setup.
 *
 * Also owns single-player games against the on-device chess AI (the AI plays
 * Black and moves through the same validation path as a human).
 */

const GAMES_KEY = "chainmate:games:v1";
const CHANNEL = "chainmate-sync";
const SUMMARY_API = "/api/ai";

function getPlayerId(): string {
  // sessionStorage keeps a per-tab identity, so two tabs can play each other.
  const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null;
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const existing = store?.getItem(LOCAL_PLAYER_KEY);
  if (existing) return existing;
  const id = `0x${randomHex(20)}`;
  store?.setItem(LOCAL_PLAYER_KEY, id);
  return id;
}

function readGames(): Record<string, GameState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(GAMES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, GameState>) : {};
  } catch {
    return {};
  }
}

function writeGames(games: Record<string, GameState>) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(GAMES_KEY, JSON.stringify(games));
}

/** Record when a move was played — powers the real chess clocks. */
function stampMoveTime(game: GameState): GameState {
  const last = game.moves[game.moves.length - 1];
  if (last && !last.at) last.at = Date.now();
  return game;
}

type Listener = (state: GameState) => void;

export class LocalGameStore implements GameStore {
  private listeners = new Map<string, Set<Listener>>();
  private channel: BroadcastChannel | null = null;
  /** Guard against duplicate AI turns (same fen scheduled twice). */
  private aiMoveInFlight = false;
  private aiMoveFen = "";

  constructor() {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (event: MessageEvent<{ id: string; state: GameState }>) => {
        this.emit(event.data.id);
      };
    }
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.onStorage);
    }
  }

  private onStorage = (event: StorageEvent) => {
    if (event.key === GAMES_KEY || event.key === null) {
      // Notify all games that have listeners.
      for (const id of this.listeners.keys()) {
        this.emit(id);
      }
    }
  };

  private emit(id: string) {
    const game = this.getGameSync(id);
    if (!game) return;
    for (const cb of this.listeners.get(id) ?? []) {
      cb(game);
    }
  }

  /**
   * Resolve a flag fall lazily: if the side to move has no time left, the
   * game ends with a timeout (the other side wins). Deterministic from the
   * recorded move timestamps, so any tab that reads the game settles it.
   */
  private maybeResolveTimeout(game: GameState): GameState {
    if (game.status !== "active" || !game.timeControl || !game.startedAt) return game;
    const clocks = computeClocks(game, Date.now());
    if (!clocks) return game;
    const turn = game.fen.split(" ")[1] ?? "w";
    const flagged = turn === "w" ? clocks.white : clocks.black;
    if (flagged > 0) return game;
    return this.save({
      ...game,
      status: "timeout",
      winner: turn === "w" ? game.opponent : game.creator,
      drawOffer: undefined,
      commentary: [
        ...game.commentary,
        {
          move: "",
          side: turn === "w" ? "white" : "black",
          text: `${turn === "w" ? "White" : "Black"} lost on time.`,
          source: "chain",
        },
      ],
    });
  }

  private getGameSync(id: string): GameState | null {
    const raw = readGames()[id] ?? null;
    if (!raw) return null;
    return this.maybeResolveTimeout(raw);
  }

  /** Persist a state and return the stored copy (timestamps bumped). */
  private save(game: GameState): GameState {
    const now = Date.now();
    const over = isGameOver(game.status);
    const next: GameState = {
      ...game,
      updatedAt: now,
      startedAt: game.startedAt ?? (game.opponent ? now : undefined),
      endedAt: game.endedAt ?? (over ? now : undefined),
      // Match reports are generated automatically the moment a game ends.
      summary: game.summary || (over ? buildRuleSummary(game) : game.summary),
    };
    const games = readGames();
    games[next.id] = next;
    writeGames(games);
    this.channel?.postMessage({ id: next.id, state: next });
    this.emit(next.id);
    return next;
  }

  async createGame(options?: CreateGameOptions): Promise<GameState> {
    const now = Date.now();
    const id = `${LOCAL_GAME_PREFIX}${randomHex(6)}`;
    const game: GameState = {
      id,
      creator: getPlayerId(),
      opponent: "",
      status: "waiting",
      winner: "",
      fen: START_FEN,
      moves: [],
      commentary: [],
      summary: "",
      backend: "local",
      timeControl: options?.timeControl,
      visibility: options?.visibility === "public" ? "public" : "private",
      createdAt: now,
      updatedAt: now,
    };
    return this.save(game);
  }

  async createAiGame(difficulty: AiDifficulty = "casual"): Promise<GameState> {
    const now = Date.now();
    const id = `${LOCAL_GAME_PREFIX}${randomHex(6)}`;
    const game: GameState = {
      id,
      creator: getPlayerId(),
      opponent: AI_PLAYER_ID,
      status: "active",
      winner: "",
      fen: START_FEN,
      moves: [],
      commentary: [],
      summary: "",
      backend: "local",
      aiDifficulty: difficulty,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    return this.save(game);
  }

  async joinGame(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    const me = getPlayerId();
    const res = joinPlayerToGame(game, me);
    if (!res.ok) throw new Error(res.error);
    return this.save(res.game);
  }

  async getGame(id: string): Promise<GameState | null> {
    return this.getGameSync(id);
  }

  async submitMove(
    id: string,
    from: string,
    to: string,
    promotion?: string,
  ): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    const me = getPlayerId();
    const res = applyMoveToGame(game, me, from, to, promotion);
    if (!res.ok) throw new Error(res.error);
    return this.save(stampMoveTime(res.game));
  }

  async submitAiMove(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    if (game.opponent !== AI_PLAYER_ID) {
      throw new Error("This game has no AI opponent");
    }
    if (game.status !== "active") return game;

    const fen = game.fen;
    // Idempotency guard: if an AI move for this exact position is already in
    // flight (or already applied), don't move twice.
    if (this.aiMoveInFlight && this.aiMoveFen === fen) return game;

    const aiSide = game.creator === AI_PLAYER_ID ? "white" : "black";
    const info = fen.split(" ")[1] ?? "w";
    if ((aiSide === "white" && info !== "w") || (aiSide === "black" && info !== "b")) {
      return game; // not the AI's turn — nothing to do
    }

    this.aiMoveInFlight = true;
    this.aiMoveFen = fen;
    try {
      const aiMove = chooseAiMove(fen, game.aiDifficulty ?? "casual");
      if (!aiMove) return game;
      const res = applyMoveToGame(game, AI_PLAYER_ID, aiMove.from, aiMove.to, aiMove.promotion);
      if (!res.ok) return game;
      return this.save(stampMoveTime(res.game));
    } finally {
      this.aiMoveInFlight = false;
      this.aiMoveFen = "";
    }
  }

  async resign(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    const me = getPlayerId();
    const res = resignPlayerFromGame(game, me);
    if (!res.ok) throw new Error(res.error);
    return this.save(res.game);
  }

  async offerDraw(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    const res = offerDrawToGame(game, getPlayerId());
    if (!res.ok) throw new Error(res.error);
    return this.save(res.game);
  }

  async respondDraw(id: string, accept: boolean): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    const res = respondToDrawOffer(game, getPlayerId(), accept);
    if (!res.ok) throw new Error(res.error);
    return this.save(res.game);
  }

  async generateSummary(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    if (!isGameOver(game.status)) throw new Error("The game is still in progress");
    if (game.summary) return game;

    let summary = buildRuleSummary(game);
    try {
      const res = await fetch(SUMMARY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "summary",
          moves: game.moves.map((m) => m.san).join(" "),
          winner: game.winner || "draw",
          result: game.status,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        if (data.text) summary = data.text;
      }
    } catch {
      // fall back to the rule-based summary
    }

    return this.save({ ...game, summary });
  }

  /** Every local game is "mine" — they all live in this browser. */
  listMyGames(): GameState[] {
    const all = Object.values(readGames());
    return all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  subscribe(id: string, callback: Listener): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(callback);
    const state = this.getGameSync(id);
    if (state) callback(state);
    return () => {
      this.listeners.get(id)?.delete(callback);
    };
  }

  getMyPlayerId(): string {
    return getPlayerId();
  }
}
