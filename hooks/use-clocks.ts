"use client";

import { useEffect, useState } from "react";
import { computeClocks, formatClock, formatClockLive, type ClockState } from "@/lib/clocks";
import type { GameState } from "@/lib/types";

export interface LiveClocks {
  white: string | null;
  black: string | null;
  /** Raw remaining milliseconds (for the authoritative 00:00 check). */
  whiteMs: number | null;
  blackMs: number | null;
  whiteLow: boolean;
  blackLow: boolean;
}

/**
 * Live chess clocks for a game. Recomputes from the real move timestamps
 * while the game is active (so the running side's clock ticks), and freezes
 * at the final values once the game ends.
 *
 * Tick cadence: one second normally, but 100ms once a side is under 20s —
 * the readout switches to tenths there (formatClockLive), so the last
 * seconds of a time scramble actually show the tenths being burned instead
 * of jumping in whole-second lurches.
 */
export function useClocks(game: GameState | null): LiveClocks {
  const [now, setNow] = useState(() => Date.now());

  const active = game?.status === "active" && Boolean(game?.timeControl);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, game?.id]);

  // The fast tick is a SEPARATE effect so the interval is only created when
  // a clock is actually low — no 100ms wake-ups during the quiet phase.
  const [low, setLow] = useState(false);
  useEffect(() => {
    if (!active || !game) return;
    const clocks = computeClocks(game, Date.now());
    setLow(!!clocks && (clocks.white < 20_000 || clocks.black < 20_000));
  }, [active, game, now]);

  useEffect(() => {
    if (!active || !low) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active, low]);

  if (!game) {
    return { white: null, black: null, whiteMs: null, blackMs: null, whiteLow: false, blackLow: false };
  }

  const frozen = game.status === "active" ? now : (game.endedAt ?? now);
  const clocks: ClockState | null = computeClocks(game, frozen);
  if (!clocks) {
    return { white: null, black: null, whiteMs: null, blackMs: null, whiteLow: false, blackLow: false };
  }

  // Frozen (ended) games keep the plain whole-second format — precision is
  // only for the live scramble.
  const live = game.status === "active";
  return {
    white: live ? formatClockLive(clocks.white) : formatClock(clocks.white),
    black: live ? formatClockLive(clocks.black) : formatClock(clocks.black),
    whiteMs: clocks.white,
    blackMs: clocks.black,
    whiteLow: clocks.white < 60_000,
    blackLow: clocks.black < 60_000,
  };
}
