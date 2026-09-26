"use client";

import { Chess } from "chess.js";

/**
 * Stockfish — the real engine, running natively on the player's device.
 *
 * ChainMate ships stockfish.js (Stockfish 10 compiled to WebAssembly) as a
 * static asset and speaks UCI to it through a Web Worker, exactly like a
 * desktop chess GUI. The engine runs entirely on-device: no API, no server,
 * no key — the strongest chess entity on Earth plays on the same terms as
 * the built-in bots.
 *
 * The WASM build is the single source of truth: copied from the stockfish.js
 * package into /public/stockfish by `scripts/copy-stockfish.mjs` (npm run
 * engine:sync), and served like any other static file.
 */

/** Where the static engine lives (under /public). */
export const STOCKFISH_DIR = "/stockfish";

/** The engine's best move, in the shape the game layer consumes. */
export interface EngineMove {
  from: string;
  to: string;
  promotion?: string;
}

/** One UCI session: a worker process, one command stream. */
class UciEngine {
  private worker: Worker;
  private lines: ((line: string) => void)[] = [];
  private closed = false;

  constructor(private scriptPath: string) {
    this.worker = new Worker(scriptPath);
  }

  /** Subscribe to raw engine output. Returns the unsubscribe function. */
  onLine(fn: (line: string) => void): () => void {
    this.lines.push(fn);
    return () => {
      this.lines = this.lines.filter((l) => l !== fn);
    };
  }

  private dispatch(data: MessageEvent) {
    const line = typeof data === "string" ? data : String(data?.data ?? data ?? "");
    for (const fn of this.lines) fn(line);
  }

  /** Send a command; resolves with every engine line until `until` matches. */
  send(command: string, until: (line: string) => boolean): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("Engine was closed"));
      const seen: string[] = [];
      const off = this.onLine((line) => {
        seen.push(line);
        if (until(line)) {
          off();
          resolve(seen);
        }
      });
      this.worker.onerror = (e) => {
        off();
        reject(new Error(`Stockfish failed to load: ${e.message ?? "unknown error"}`));
      };
      this.worker.onmessage = (e) => this.dispatch(e);
      this.worker.postMessage(command);
    });
  }

  async start(): Promise<void> {
    await this.send("uci", (l) => l === "uciok");
    // MultiPV 3: the search reports its top three lines. bestMove() picks at
    // random among the near-best of them — without this, UCI search is fully
    // deterministic and the engine replayed the SAME game whenever its
    // opponent opened the same way (the "Stockfish is scripted" complaint).
    await this.send("setoption name MultiPV value 3", () => true);
    await this.send("isready", (l) => l === "readyok");
  }

  async setOption(name: string, value: string | number): Promise<void> {
    await this.send(`setoption name ${name} value ${value}`, () => true);
  }

  /**
   * Best move for the position. `movetime` caps the think; `depth` caps the
   * search when provided (native multi-threaded/real-depth play).
   *
   * With MultiPV on, the `info … multipv N … score CP/MATE … pv X` lines rank
   * the top three candidates. The engine's own bestmove is always available,
   * but the choice among lines scoring within CP_MARGIN of the best is drawn
   * at random — a repertoire instead of a script. Mate scores collapse the
   * candidate set on their own, so a forced win is never traded away.
   */
  async bestMove(
    fen: string,
    opts: { movetime?: number; depth?: number } = {},
  ): Promise<EngineMove | null> {
    // "position fen …" + "go" — the engine is stateless between sends here
    // because both commands go into the same stream before we await.
    this.worker.postMessage(`position fen ${fen}`);
    const goArgs = opts.depth ? `depth ${opts.depth}` : `movetime ${opts.movetime ?? 1000}`;
    const lines = await this.send(`go ${goArgs}`, (l) => l.startsWith("bestmove"));
    const best = lines.find((l) => l.startsWith("bestmove"));
    const uci = best?.split(/\s+/)[1];
    if (!uci || uci === "(none)") return null;

    // Candidates from the MultiPV info lines, best score first.
    const CP_MARGIN = 25; // centipawns — one pawn is 100; 25 is "same practical strength"
    type Cand = { uci: string; cp: number };
    const cands: Cand[] = [];
    for (const line of lines) {
      const mpv = /\bmultipv (\d+)/.exec(line);
      const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
      const pv = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line);
      if (!mpv || !score || !pv) continue;
      const cp = score[1] === "mate" ? (Number(score[2]) > 0 ? 100_000 : -100_000) : Number(score[2]);
      cands.push({ uci: pv[1]!, cp });
    }
    cands.sort((a, b) => b.cp - a.cp);
    const top = cands[0];
    if (top) {
      const pool = cands.filter((c) => top.cp - c.cp <= CP_MARGIN);
      const pick = pool[Math.floor(Math.random() * pool.length)] ?? top;
      const move = parseUciMove(fen, pick.uci);
      if (move) return move; // parse failure → fall through to the engine's own move
    }
    return parseUciMove(fen, uci);
  }

  quit(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage("quit");
    } catch {
      /* the worker may already be gone */
    }
    this.worker.terminate();
  }
}

/**
 * Convert a UCI move (e2e4, e7e8q) into the game layer's shape, validating
 * against the position. Chess.js 1.x parses promotion strings like "q"
 * directly; the SAN-based call goes through the library's own legality
 * checks so an engine glitch can never inject an illegal move.
 */
export function parseUciMove(fen: string, uci: string): EngineMove | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci.trim().toLowerCase());
  if (!m) return null;
  const chess = new Chess(fen);
  try {
    const move = chess.move({ from: m[1]!, to: m[2]!, promotion: m[3] });
    return { from: move.from, to: move.to, promotion: move.promotion };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Session cache — one engine, kept warm                               */
/* ------------------------------------------------------------------ */

let cached: UciEngine | null = null;
let booting: Promise<UciEngine> | null = null;
let failed = false;

/** Load (or reuse) the native engine. Rejects when unavailable. */
export function getStockfish(): Promise<UciEngine> {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return Promise.reject(new Error("Stockfish needs a browser with Web Workers"));
  }
  if (cached) return Promise.resolve(cached);
  if (failed) return Promise.reject(new Error("Stockfish is unavailable on this device"));
  booting ??= (async () => {
    const engine = new UciEngine(`${STOCKFISH_DIR}/stockfish.wasm.js`);
    await engine.start();
    cached = engine;
    return engine;
  })().catch((err) => {
    failed = true; // never retry-spam a broken engine this session
    booting = null;
    throw err;
  });
  return booting;
}

/** True once we know (or believe) the native engine can't load. */
export function stockfishFailed(): boolean {
  return failed;
}

/** Ask the native engine for a move; returns null when it finds none. */
export async function stockfishMove(
  fen: string,
  opts: { movetime?: number; depth?: number } = {},
): Promise<EngineMove | null> {
  const engine = await getStockfish();
  return engine.bestMove(fen, opts);
}

/** Release the engine (tab hidden for a long while, tests). */
export function quitStockfish(): void {
  cached?.quit();
  cached = null;
  booting = null;
}

/** Test hook: forget the cached engine without terminating it. */
export function __resetStockfishForTests(): void {
  cached = null;
  booting = null;
  failed = false;
}
