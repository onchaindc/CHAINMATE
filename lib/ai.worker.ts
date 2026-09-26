/// <reference lib="webworker" />
import { chooseAiMove } from "@/lib/ai-engine";
import type { AiDifficulty } from "@/lib/types";

/**
 * The engine, off the main thread.
 *
 * The top levels think for up to ~2.5s; run synchronously that freezes every
 * animation, the clock's pulse and the "thinking…" indicator for the whole
 * search. This worker owns the search instead, so the board stays live while
 * the bot thinks. The request/response contract mirrors lib/ai-runner.ts.
 */

export interface AiWorkerRequest {
  id: number;
  fen: string;
  difficulty: AiDifficulty;
  /** SAN history for the opening book (empty → book skipped). */
  sanHistory: string[];
  /** Think budget in ms (see botThinkTimeMs); absent → the level profile. */
  thinkMs?: number;
}

export interface AiWorkerResponse {
  id: number;
  move: { from: string; to: string; promotion?: string } | null;
  /** Set when the search itself threw — the runner falls back to sync. */
  error?: string;
}

self.onmessage = (event: MessageEvent<AiWorkerRequest>) => {
  const { id, fen, difficulty, sanHistory, thinkMs } = event.data;
  try {
    // Native Stockfish never reaches this worker (it owns a UCI worker of
    // its own — see lib/ai-runner.ts). If a misrouted request ever arrives,
    // search at the top built-in profile instead of returning garbage.
    const move = chooseAiMove(fen, difficulty === "stockfish" ? "apex" : difficulty, sanHistory, thinkMs);
    const response: AiWorkerResponse = { id, move };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: AiWorkerResponse = {
      id,
      move: null,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
