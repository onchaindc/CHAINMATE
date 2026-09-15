"use client";

/**
 * Nimiq provider state hook — Phase 1A foundation (hardened for Nimiq Pay).
 *
 * One clean state machine for "is there a Nimiq wallet here?", built on the
 * SDK's init(): the host (Nimiq Pay) injects window.nimiq via an injected
 * script whose execution is NOT guaranteed to precede this app bundle —
 * especially on a cold-started WebView. A single timed poll therefore
 * misreports "no wallet" inside Nimiq Pay itself. This hook:
 *
 *   1. runs init() with a short timeout,
 *   2. runs ONE delayed second pass before settling (covers injection lag),
 *   3. classifies the settled outcome host-aware: inside a Nimiq host
 *      (window.nimiq or window.nimiqPay visible) a missing provider is an
 *      ERROR the user can retry — never "web-unavailable", because telling
 *      someone inside Nimiq Pay to open Nimiq Pay is a lie,
 *   4. reports "web-unavailable" only for a genuine plain browser tab, where
 *      that is the normal case, not a failure.
 *
 * The decision core is a pure exported function so the matrix is unit-testable
 * without a DOM.
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
   * Re-run detection (e.g. after the user navigates back into the Mini App,
   * or taps Retry on an error). No-op while a detection pass — including a
   * pending delayed retry — is already running.
   */
  recheck: () => void;
}

/** How long each init() pass waits for the host to inject the provider. */
const DETECT_TIMEOUT_MS = 3_000;
/**
 * Delay before the one extra detection pass. Two passes ≈ 8s worst case,
 * which comfortably covers Nimiq Pay's cold-start injection lag without
 * leaving the UI in "detecting" forever.
 */
const RETRY_DELAY_MS = 2_000;

/** True when the page can see any Nimiq host injection (provider or context). */
export function hasNimiqHost(): boolean {
  return (
    typeof window !== "undefined" &&
    ("nimiq" in window || "nimiqPay" in window)
  );
}

/** Settled outcome of the detection passes — what the state machine adopts. */
export type SettledProviderState =
  | { state: "available"; error: null }
  | { state: "web-unavailable"; error: null }
  | { state: "error"; error: NimiqWalletError };

/**
 * Pure decision core (exported for tests): map an init() outcome plus what
 * the host window shows onto the settled provider state.
 *
 * - init ok                        → available
 * - init failed, host present      → error (retryable — the host OWES us a
 *                                    provider; a missing one is its bug, a
 *                                    transient race, or an outdated Pay)
 * - init failed, no host anywhere  → web-unavailable (plain browser tab)
 */
export function classifyProviderState(
  initOk: boolean,
  hostPresent: boolean,
  initError: NimiqWalletError | null,
): SettledProviderState {
  if (initOk) return { state: "available", error: null };
  if (hostPresent) {
    return {
      state: "error",
      error:
        initError ?? {
          kind: "provider",
          message: "The Nimiq provider did not become ready inside Nimiq Pay.",
        },
    };
  }
  return { state: "web-unavailable", error: null };
}

export function useNimiq(): NimiqProvider {
  const [state, setState] = useState<NimiqProviderState>("detecting");
  const [error, setError] = useState<NimiqWalletError | null>(null);
  const running = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  const detect = useCallback(() => {
    if (running.current) return;
    clearRetry();
    running.current = true;

    async function attempt(pass: number): Promise<void> {
      try {
        setState("detecting");
        setError(null);

        let enabled = true;
        try {
          const { isNimiqEnabled } = await import("@/lib/nimiq/flag");
          enabled = isNimiqEnabled();
        } catch {
          // Flag module failed to load: treat as enabled and let detection
          // surface the real provider state. This flag gates UI only.
        }
        if (!enabled) {
          setState("unavailable");
          return;
        }

        const result = await connectNimiq(DETECT_TIMEOUT_MS);
        if (result.ok) {
          setState("available");
          return;
        }

        // One delayed second pass: the host may still be injecting window.nimiq.
        if (pass === 0) {
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            void attempt(1);
          }, RETRY_DELAY_MS);
          return; // running stays true while the retry is pending
        }

        const settled = classifyProviderState(false, hasNimiqHost(), result.error);
        setState(settled.state);
        setError(settled.error);
      } finally {
        // Only release the run lock when no retry is pending.
        if (retryTimer.current === null) running.current = false;
      }
    }

    void attempt(0);
  }, [clearRetry]);

  useEffect(() => {
    detect();
    return () => {
      // Unmount: drop any pending retry so it cannot run after teardown.
      clearRetry();
      running.current = false;
    };
  }, [detect, clearRetry]);

  return { state, error, recheck: detect };
}
