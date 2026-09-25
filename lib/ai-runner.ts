"use client";

import { isStockfishLevel, type AiDifficulty } from "@/lib/types";
import type { AiWorkerRequest, AiWorkerResponse } from "@/lib/ai.worker";

/**
 * Run the engine off the main thread when the browser allows it, and fall
 * back to a synchronous search when it does not (SSR, tests, hardened CSPs).
 * The caller only ever awaits a move either way.
 *
 * Two engines live behind this one door:
 *   - the built-in search (lib/ai-engine.ts), inside our own worker;
 *   - native Stockfish (lib/stockfish.ts), a UCI worker of its own — the
 *     WASM build must be a worker's top-level script, so it cannot share
 *     ours. The main thread only relays its messages; the search itself
 *     never blocks the board either way.
 */

interface PendingRequest {
  resolve: (move: { from: string; to: string; promotion?: string } | null) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    workerBroken = true;
    return null;
  }
  try {
    const w = new Worker(new URL("./ai.worker.ts", import.meta.url));
    w.onmessage = (event: MessageEvent<AiWorkerResponse>) => {
      const req = pending.get(event.data.id);
      if (!req) return;
      pending.delete(event.data.id);
      if (event.data.error) req.reject(new Error(event.data.error));
      else req.resolve(event.data.move);
    };
    w.onerror = () => {
      // The worker failed to load (CSP, build quirk). Fail everything
      // pending and remember not to try again this session.
      workerBroken = true;
      worker = null;
      for (const req of pending.values()) req.reject(new Error("AI worker unavailable"));
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Ask the worker (or the sync engine) for the AI's move. */
export async function requestAiMove(
  fen: string,
  difficulty: AiDifficulty,
  sanHistory: string[],
): Promise<{ from: string; to: string; promotion?: string } | null> {
  // The native engine answers for its own level. It is only available in a
  // real browser; anywhere else the request falls through to the built-in
  // search at its profile, so Stockfish never silently stops playing.
  if (isStockfishLevel(difficulty) && typeof window !== "undefined") {
    const { stockfishMove } = await import("@/lib/stockfish");
    const move = await stockfishMove(fen, { movetime: 1200 });
    if (move) return move;
    // Engine missing or found nothing legal — degrade to the top built-in
    // level rather than hanging the game on a null reply.
  }
  const w = getWorker();
  if (!w) {
    // Fallback: synchronous search (blocks, but only in environments where
    // a worker was never an option).
    return import("@/lib/ai-engine").then(({ chooseAiMove }) =>
      Promise.resolve(chooseAiMove(fen, difficulty, sanHistory)),
    );
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: AiWorkerRequest = { id, fen, difficulty, sanHistory };
    w.postMessage(request);
  });
}
