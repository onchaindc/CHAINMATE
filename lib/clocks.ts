import type { GameState } from "@/lib/types";

/**
 * Chess clocks derived from REAL data: the game's time control, the recorded
 * start time, and the per-move timestamps the stores stamp when a move is
 * played. Nothing is simulated — elapsed time comes straight off the move
 * records, so both players see the same clock.
 */

export interface ClockState {
  /** Milliseconds remaining, per side. */
  white: number;
  black: number;
}

/**
 * Parse a time-control label into { baseMs, incrementMs }.
 *
 * Understands the classic "5 + 0" / "15 + 10" minutes+increment form (with
 * fractional minutes), the explicit "3m 45s" / "3m45s" form, and the daily
 * correspondence form "1d" / "3d". The clock, the timeout sweep and the
 * server all funnel through this one parser, so a label only has to parse
 * here to work everywhere.
 */
export function parseTimeControl(
  timeControl: string | undefined,
): { baseMs: number; incrementMs: number } | null {
  if (!timeControl) return null;
  const raw = timeControl.trim();
  const days = /^(\d+(?:\.\d+)?)\s*d(?:\s*\+\s*(\d+(?:\.\d+)?))?$/i.exec(raw);
  if (days) {
    return {
      baseMs: Math.max(0, parseFloat(days[1]!)) * 86_400_000,
      incrementMs: Math.max(0, parseFloat(days[2] ?? "0")) * 1000,
    };
  }
  const minSec = /^(\d+(?:\.\d+)?)\s*m\s*(\d+(?:\.\d+)?)?\s*s?$/i.exec(raw);
  if (minSec) {
    return {
      baseMs:
        Math.max(0, parseFloat(minSec[1]!)) * 60_000 +
        Math.max(0, parseFloat(minSec[2] ?? "0")) * 1000,
      incrementMs: 0,
    };
  }
  const parts = raw.split("+").map((p) => parseFloat(p.trim()));
  if (parts.length === 0 || !Number.isFinite(parts[0] ?? NaN)) return null;
  return {
    baseMs: Math.max(0, parts[0] ?? 0) * 60_000,
    incrementMs: Math.max(0, parts[1] ?? 0) * 1000,
  };
}

/**
 * Clock remaining at `now` for a game with move timestamps. Returns null when
 * the game has no time control or no start time (clocks are only shown where
 * the data exists).
 */
export function computeClocks(game: GameState, now: number): ClockState | null {
  const tc = parseTimeControl(game.timeControl);
  if (!tc || !game.startedAt) return null;

  // Presence gate: for tournament games the clock starts only when BOTH
  // players have checked in at the board. Before that instant the clocks sit
  // at their full base time — nobody loses a second waiting for the other to
  // find the room.
  const clockStart = game.clockStartedAt ?? game.startedAt;
  const effectiveStart = Math.max(game.startedAt, clockStart);

  let white = tc.baseMs;
  let black = tc.baseMs;

  // Move timestamps: moves[0] was played at moves[0].at, and the previous
  // instant was effectiveStart (or the previous move). Each mover pays the
  // elapsed time of their own turn and receives the increment afterwards.
  let prev = effectiveStart;
  for (let i = 0; i < game.moves.length; i++) {
    const at = game.moves[i].at;
    if (!at) return null; // no timestamps recorded — clocks unavailable
    const elapsed = Math.max(0, at - prev);
    if (i % 2 === 0) white = white - elapsed + tc.incrementMs;
    else black = black - elapsed + tc.incrementMs;
    prev = at;
  }

  // The side to move is still thinking: tick their clock up to `now`, but
  // never before the clock itself was started (waiting for an absent player
  // burns nobody's time).
  if (game.status === "active") {
    const turn = game.fen.split(" ")[1] ?? "w";
    const elapsed = Math.max(0, now - Math.max(prev, effectiveStart));
    if (turn === "w") white -= elapsed;
    else black -= elapsed;
  }

  return { white: Math.max(0, white), black: Math.max(0, black) };
}

/** "08:42" / "1:04:03" from milliseconds. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
