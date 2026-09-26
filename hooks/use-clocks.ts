"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeClocks,
  formatClock,
  formatClockLive,
  TENTH_THRESHOLD_MS,
  type ClockState,
} from "@/lib/clocks";
import { serverNow } from "@/lib/server-clock";
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
 * Tick cadence: one second normally, but 100ms once a side is under the
 * tenths threshold — the readout switches to tenths there (formatClockLive),
 * so the last seconds of a time scramble show the tenths being burned. ONE
 * interval runs at a time and it is recreated only when a clock crosses the
 * threshold, so the quiet phase costs a 1Hz wake-up and nothing more.
 *
 * Every fresh game object (mount, poll, navigation) also re-anchors "now"
 * immediately — without that, the readout held the value captured at mount
 * and could sit still or lurch until the first interval fired.
 */
export function useClocks(game: GameState | null): LiveClocks {
  const [now, setNow] = useState(() => Date.now());
  const active = game?.status === "active" && Boolean(game?.timeControl);

  // Mirror of "is either clock under the tenths threshold", kept in a ref so
  // the tick can flip the interval's cadence without an extra render pass.
  const lowRef = useRef(false);

  /**
   * What "now" is: server time for hosted games (move stamps are server
   * times — ticking them against the device clock showed different clocks to
   * devices that disagree), device time for local games, whose stamps are
   * device-made and whose players never taught the offset module anything.
   */
  const isHosted = game?.backend === "hosted";
  const nowMs = useCallback((): number => (isHosted ? serverNow() : Date.now()), [isHosted]);

  useEffect(() => {
    if (!active) return;
    // Re-anchor on every game update (the hosted store polls every 2s and
    // yields a new object each time). Cheap, and it keeps the displayed
    // second honest right after the state arrives.
    setNow(nowMs());

    /** Is either remaining time inside the tenths window? */
    const isLow = (): boolean => {
      if (!game) return false;
      const clocks = computeClocks(game, nowMs());
      return (
        !!clocks &&
        (clocks.white < TENTH_THRESHOLD_MS || clocks.black < TENTH_THRESHOLD_MS)
      );
    };

    lowRef.current = isLow();

    /**
     * One interval, recreated only when the cadence regime changes. It
     * updates the time and — on each tick — checks whether a clock has
     * entered or left the tenths window, flipping the cadence by replacing
     * itself. There is never more than one interval running.
     */
    let timer: ReturnType<typeof setInterval> | undefined;
    const arm = (ms: number) => {
      if (timer) clearInterval(timer);
      timer = setInterval(tick, ms);
    };
    const tick = () => {
      setNow(nowMs());
      const low = isLow();
      if (low !== lowRef.current) {
        lowRef.current = low;
        arm(low ? 100 : 1000);
      }
    };
    arm(lowRef.current ? 100 : 1000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [active, game, nowMs]);

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
