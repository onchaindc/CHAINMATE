"use client";

/**
 * Nimiq provider state hook — Phase 1A foundation.
 *
 * One clean state machine for "is there a Nimiq wallet here?", built on the
 * SDK's init(): the host (Nimiq Pay) injects window.nimiq before the page
 * loads, so a short detection pass is all a Mini App needs. Outside a host —
 * a plain browser tab — init() times out and the hook reports web-unavailable
 * rather than an error, because that is the normal case, not a failure.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  connectNimiq,
  type NimiqWalletError,
} from "@/lib/nimiq/miniapp";

export type NimiqProviderState =
  | "detecting" // mounted, waiting for the injection window to close
  | "available" // window.nimiq found — wallet calls can proceed
  | "unavailable" // feature disabled by config (NEXT_PUBLIC_NIMIQ_ENABLED)
  | "web-unavailable" // normal browser tab, no Nimiq host — not an error
  | "error"; // something actually went wrong

export interface NimiqProvider {
  state: NimiqProviderState;
  /** Populated for "error" (and "web-unavailable" when the SDK said why). */
  error: NimiqWalletError | null;
  /**
   * Re-run detection (e.g. after a user navigates back into the Mini App).
   * No-op while a detection pass is already running.
   */
  recheck: () => void;
}

/** How long to wait for the host to inject the provider before giving up. */
const DETECT_TIMEOUT_MS = 3_000;

export function useNimiq(): NimiqProvider {
  const [state, setState] = useState<NimiqProviderState>("detecting");
  const [error, setError] = useState<NimiqWalletError | null>(null);
  const running = useRef(false);

  const detect = useCallback(() => {
    if (running.current) return;
    running.current = true;

    async function run() {
      setState("detecting");
      setError(null);
      try {
        const { isNimiqEnabled } = await import("@/lib/nimiq/flag");
        if (!isNimiqEnabled()) {
          setState("unavailable");
          return;
        }
        const result = await connectNimiq(DETECT_TIMEOUT_MS);
        if (result.ok) {
          setState("available");
        } else {
          // Timeout inside a Nimiq host would be a provider error; outside a
          // host it is the expected "plain web" case.
          const isPlainWeb = typeof window !== "undefined" && !("nimiq" in window);
          if (isPlainWeb) {
            setState("web-unavailable");
          } else {
            setState("error");
            setError(result.error);
          }
        }
      } catch (err) {
        setState("error");
        setError({
          kind: "unknown",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        running.current = false;
      }
    }

    void run();
  }, []);

  useEffect(() => {
    detect();
  }, [detect]);

  return { state, error, recheck: detect };
}
