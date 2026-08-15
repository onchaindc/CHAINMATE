"use client";

import {
  applyChessMove,
  describePosition,
} from "@/lib/chess";
import { LOCAL_GAME_PREFIX, LOCAL_PLAYER_KEY } from "@/lib/config";
import { buildRuleSummary } from "@/lib/summary";
import {
  isGameOver,
  type CommentaryEntry,
  type GameState,
  type GameStore,
} from "@/lib/types";
import { START_FEN } from "@/lib/types";

/**
 * Built-in offline game store. Game state lives in localStorage and syncs
 * across tabs of the same browser via BroadcastChannel + storage events, so
 * two players on one machine can play a full game with zero setup.
 *
 * Move validation mirrors the GenLayer contract (contracts/chainmate.py)
 * using chess.js, so the two backends behave identically.
 */

const GAMES_KEY = "chainmate:games:v1";
const CHANNEL = "chainmate-sync";
const SUMMARY_API = "/api/ai";

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

type Listener = (state: GameState) => void;

export class LocalGameStore implements GameStore {
  private listeners = new Map<string, Set<Listener>>();
  private channel: BroadcastChannel | null = null;

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

  private getGameSync(id: string): GameState | null {
    return readGames()[id] ?? null;
  }

  private save(game: GameState) {
    const games = readGames();
    games[game.id] = game;
    writeGames(games);
    this.channel?.postMessage({ id: game.id, state: game });
    this.emit(game.id);
  }

  async createGame(): Promise<GameState> {
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
    };
    this.save(game);
    return game;
  }

  async joinGame(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    if (game.status !== "waiting") throw new Error("This game is not waiting for players");
    const me = getPlayerId();
    if (game.creator === me) throw new Error("You cannot join your own game");
    const next: GameState = { ...game, opponent: me, status: "active" };
    this.save(next);
    return next;
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
    if (game.status !== "active") throw new Error("The game is not active");

    const me = getPlayerId();
    const mySide = game.creator === me ? "white" : game.opponent === me ? "black" : null;
    if (!mySide) throw new Error("You are not a player in this game");

    const info = describePosition(game.fen);
    const expected = info.turn === "w" ? "white" : "black";
    if (mySide !== expected) throw new Error("It is not your turn");

    const outcome = applyChessMove(game.fen, from, to, promotion);
    if (!outcome.ok || !outcome.move || !outcome.fen) {
      throw new Error(outcome.error ?? "Illegal move");
    }

    const after = describePosition(outcome.fen);
    const capturedName =
      outcome.move.captured === "p" ? "pawn" : outcome.move.captured ?? null;
    let text: string;
    if (outcome.move.san === "O-O" || outcome.move.san === "O-O-O") {
      text = `${mySide === "white" ? "White" : "Black"} castles ${
        outcome.move.san === "O-O" ? "kingside" : "queenside"
      }, tucking the king behind a wall of pawns (${outcome.move.san}).`;
    } else if (outcome.move.promotion) {
      text = `Promotion! ${mySide === "white" ? "White" : "Black"} plays ${outcome.move.san}.`;
    } else if (capturedName) {
      text = `${mySide === "white" ? "White" : "Black"} captures a ${capturedName} with ${outcome.move.san}.`;
    } else {
      text = `${mySide === "white" ? "White" : "Black"} plays ${outcome.move.san}.`;
    }
    if (after.isCheckmate) {
      text += " That is checkmate — the game is over!";
    } else if (after.inCheck) {
      text += " This move puts the opponent in check.";
    }
    const entry: CommentaryEntry = { move: outcome.move.san, side: mySide, text, source: "chain" };

    let status: GameState["status"] = "active";
    let winner = "";
    if (after.isCheckmate) {
      status = "checkmate";
      winner = me;
    } else if (after.isStalemate) {
      status = "stalemate";
    } else if (after.isDraw) {
      status = "draw";
    }

    const next: GameState = {
      ...game,
      fen: outcome.fen,
      status,
      winner,
      moves: [
        ...game.moves,
        {
          number: game.moves.length + 1,
          side: mySide,
          from,
          to,
          promotion: promotion ?? "",
          san: outcome.move.san,
        },
      ],
      commentary: [...game.commentary, entry],
    };
    this.save(next);
    return next;
  }

  async resign(id: string): Promise<GameState> {
    const game = this.getGameSync(id);
    if (!game) throw new Error("Game not found");
    if (game.status !== "active") throw new Error("The game is not active");

    const me = getPlayerId();
    const mySide = game.creator === me ? "white" : game.opponent === me ? "black" : null;
    if (!mySide) throw new Error("You are not a player in this game");

    const next: GameState = {
      ...game,
      status: "resigned",
      winner: mySide === "white" ? game.opponent : game.creator,
      commentary: [
        ...game.commentary,
        {
          move: "",
          side: mySide,
          text: `${mySide === "white" ? "White" : "Black"} resigned the game.`,
          source: "chain",
        },
      ],
    };
    this.save(next);
    return next;
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

    const next: GameState = { ...game, summary };
    this.save(next);
    return next;
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
