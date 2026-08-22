"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";

/** Poll interval while waiting in the seek pool. */
const SEEK_POLL_MS = 2500;
/**
 * How long to keep searching before giving up. ~90s: long enough that two
 * people who agreed to play at the same moment actually find each other, short
 * enough that nobody stares at a dead spinner. Same figure the create page
 * uses — this is the one live-matchmaking behaviour in the app and both
 * entry points wait exactly as long.
 */
const MAX_SEEK_ATTEMPTS = Math.round(90_000 / SEEK_POLL_MS);

/** Module scope, so it is not a changing dependency of the callbacks below. */
function store(): HostedGameStore {
  return getStore("hosted") as HostedGameStore;
}

export interface Matchmaking {
  /** Registering with the server — the request is in flight. */
  starting: boolean;
  /** In the pool, polling for a partner. */
  seeking: boolean;
  error: string | null;
  /** Enter the pool. Navigates to the game as soon as a pair is found. */
  start: (timeControl: string) => Promise<void>;
  /** Leave the pool. */
  cancel: () => void;
}

/**
 * Live matchmaking as a hook, so a page can offer one-click pairing without
 * re-implementing the register → poll → give-up → cancel sequence. Leaving the
 * page cancels a pending search, otherwise the pool fills with players who are
 * no longer waiting and everyone gets paired against a ghost.
 */
export function useMatchmaking(): Matchmaking {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  /* Mirrors `seeking` for the unmount path: reading the state variable there
     would see whatever value was captured when the effect last ran. */
  const active = useRef(false);

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (active.current) {
        active.current = false;
        void store().cancelSeek().catch(() => {});
      }
    };
  }, []);

  const start = useCallback(
    async (timeControl: string) => {
      setError(null);
      setStarting(true);
      attempts.current = 0;
      try {
        const first = await store().seekMatch(timeControl);
        if (!mounted.current) return;
        if (first.status === "matched") {
          // Matched on registration — someone was already waiting.
          router.push(`/game/${first.game.id}`);
          return;
        }
        setStarting(false);
        setSeeking(true);
        active.current = true;

        const poll = () => {
          timer.current = setTimeout(async () => {
            if (!mounted.current) return;
            attempts.current += 1;
            if (attempts.current >= MAX_SEEK_ATTEMPTS) {
              setSeeking(false);
              active.current = false;
              void store().cancelSeek().catch(() => {});
              return;
            }
            try {
              const result = await store().pollSeek(timeControl);
              if (result.status === "matched") {
                setSeeking(false);
                active.current = false;
                router.push(`/game/${result.game.id}`);
                return;
              }
            } catch {
              // Transient network error — keep waiting rather than dropping
              // the player out of the pool.
            }
            poll();
          }, SEEK_POLL_MS);
        };
        poll();
      } catch (err) {
        if (!mounted.current) return;
        setStarting(false);
        setSeeking(false);
        active.current = false;
        setError(err instanceof Error ? err.message : "Failed to find an opponent");
      }
    },
    [router],
  );

  const cancel = useCallback(() => {
    setSeeking(false);
    setStarting(false);
    active.current = false;
    stopPolling();
    void store().cancelSeek().catch(() => {});
  }, [stopPolling]);

  return { starting, seeking, error, start, cancel };
}
