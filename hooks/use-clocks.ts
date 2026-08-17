"use client";

import { useEffect, useState } from "react";
import { computeClocks, formatClock, type ClockState } from "@/lib/clocks";
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
 * every second while the game is active (so the running side's clock ticks),
 * and freezes at the final values once the game ends.
 */
export function useClocks(game: GameState | null): LiveClocks {
  const [now, setNow] = useState(() => Date.now());

  const active = game?.status === "active" && Boolean(game?.timeControl);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, game?.id]);

  if (!game) {
    return { white: null, black: null, whiteMs: null, blackMs: null, whiteLow: false, blackLow: false };
  }

  const frozen = game.status === "active" ? now : (game.endedAt ?? now);
  const clocks: ClockState | null = computeClocks(game, frozen);
  if (!clocks) {
    return { white: null, black: null, whiteMs: null, blackMs: null, whiteLow: false, blackLow: false };
  }

  return {
    white: formatClock(clocks.white),
    black: formatClock(clocks.black),
    whiteMs: clocks.white,
    blackMs: clocks.black,
    whiteLow: clocks.white < 60_000,
    blackLow: clocks.black < 60_000,
  };
}
