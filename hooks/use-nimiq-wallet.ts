"use client";

/**
 * Nimiq wallet binding hook — Phase 1B client integration.
 *
 * Drives the REAL flow end to end: provider detection (Phase 1A's
 * useNimiq) → server challenge → wallet signature via the Phase 1A wrapper →
 * server verification/binding → linked state. There is no fake connected
 * state: "linked" only ever reflects what GET /api/nimiq/wallet reports after
 * a server-verified bind.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  pickWalletAccount,
  signNimiqMessage,
  type NimiqWalletError,
} from "@/lib/nimiq/miniapp";
import { useNimiq, type NimiqProviderState } from "@/hooks/use-nimiq";
import { getIdentityToken } from "@/lib/identity";

export interface LinkedWallet {
  address: string;
  network: string;
  linkedAt: number;
}

export type WalletLinkPhase =
  | "idle" // nothing happening
  | "awaiting-wallet" // challenge issued, wallet signing
  | "verifying" // signature posted, server verifying
  | "linked" // wallet bound
  | "error";

/** Shorten an address for display: NQ07 0000 … 0000 (first and last group). */
export function shortNimiqAddress(address: string): string {
  const clean = address.replace(/\s/g, "");
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = getIdentityToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

const AUTO_CONNECT_KEY = "chainmate:wallet-auto-connect:v1";

/** Whether auto-connect is enabled for this player (default: on). */
function hasWalletAutoConnect(playerId: string): boolean {
  if (typeof localStorage === "undefined" || !playerId) return false;
  try {
    return localStorage.getItem(`${AUTO_CONNECT_KEY}:${playerId}`) !== "off";
  } catch {
    return false;
  }
}

/** Persist the player's disconnect as a permanent auto-connect opt-out. */
function forgetWalletAutoConnect(playerId: string): void {
  if (typeof localStorage === "undefined" || !playerId) return;
  try {
    localStorage.setItem(`${AUTO_CONNECT_KEY}:${playerId}`, "off");
  } catch {
    // best-effort
  }
}

export function useNimiqWallet(playerId: string) {
  const provider = useNimiq();
  const [wallet, setWallet] = useState<LinkedWallet | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<WalletLinkPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ wallet: LinkedWallet | null }>(
        `/api/nimiq/wallet?playerId=${encodeURIComponent(playerId)}`,
      );
      setWallet(data.wallet);
    } catch {
      setWallet(null);
    } finally {
      setLoaded(true);
    }
  }, [playerId]);

  useEffect(() => {
    if (!playerId) return;
    void refresh();
  }, [playerId, refresh]);

  /**
   * Auto-connect (one time): the first time the app opens inside Nimiq Pay,
   * run the link flow automatically so the player never has to find the
   * Connect button. Nimiq Pay still mediates every step with its own UI —
   * this only removes the need to tap Connect first. Runs ONLY when the
   * provider is available (inside Nimiq Pay — a normal browser never injects
   * it) and never again after the player unlinks (that is the permanent
   * "disconnect" — being stubborn here is how apps lose users).
   */
  /**
   * Full link flow. Signs the server challenge with the real wallet provider
   * (Nimiq Pay) and posts it for verification. Replaces an existing wallet
   * only when the caller passes replace.
   */
  const link = useCallback(
    async (options?: { replace?: boolean }) => {
      if (provider.state !== "available") {
        setError(
          provider.state === "web-unavailable"
            ? "Open ChainMate inside Nimiq Pay to connect your wallet."
            : provider.state === "error" && provider.error
              ? provider.error.message
              : "Nimiq wallet is not available right now.",
        );
        setPhase("error");
        return;
      }
      setError(null);
      setPhase("awaiting-wallet");
      try {
        // 1. Server-issued challenge (deterministic message, 5-minute TTL).
        const { challenge } = await api<{
          challenge: {
            nonce: string;
            message: string;
            network: string;
            issuedAt: number;
          };
        }>("/api/nimiq/challenge", {
          method: "POST",
          body: JSON.stringify({ playerId }),
        });

        // 2. Connect the real wallet provider: init() + listAccounts(), with
        //    the empty-account state surfaced as its own typed error.
        const picked = await pickWalletAccount();
        if (!picked.ok) {
          throw new Error(picked.error.message);
        }
        const { nimiq: connected, account: displayAccount } = picked.value;

        const signed = await signNimiqMessage(connected, {
          message: challenge.message,
        });
        if (!signed.ok) {
          throw new Error(signed.error.message);
        }

        // 3. Server verifies (signature, key→address derivation, challenge
        //    state) and binds. The server re-derives the address, so the
        //    display account is passed only as a cross-check.
        setPhase("verifying");
        const { wallet: linked } = await api<{ wallet: LinkedWallet | null }>(
          "/api/nimiq/wallet",
          {
            method: "POST",
            body: JSON.stringify({
              playerId,
              nonce: challenge.nonce,
              signature: signed.value.signature,
              publicKey: signed.value.publicKey,
              address: displayAccount,
              network: challenge.network,
              replace: options?.replace === true,
            }),
          },
        );
        setWallet(linked);
        setPhase("linked");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to link wallet");
        setPhase("error");
      }
    },
    [playerId, provider.state, provider.error],
  );

  /**
   * Auto-connect (one time): the first time the app opens inside Nimiq Pay,
   * run the link flow automatically so the player never has to find the
   * Connect button. Nimiq Pay still mediates every step with its own UI —
   * this only removes the need to tap Connect first. Runs ONLY when the
   * provider is available (inside Nimiq Pay — a normal browser never injects
   * it) and never again after the player unlinks (that is the permanent
   * "disconnect" — being stubborn here is how apps lose users).
   */
  const autoConnectTried = useRef(false);
  useEffect(() => {
    if (autoConnectTried.current || !playerId || !loaded) return;
    if (provider.state !== "available") return;
    if (wallet) return;
    if (!hasWalletAutoConnect(playerId)) return;
    autoConnectTried.current = true;
    void link().catch(() => undefined);
  }, [playerId, loaded, provider.state, wallet, link]);

  const unlink = useCallback(async () => {
    setError(null);
    try {
      // The DELETE route reads the identity from the query string (same
      // contract as the GET above) — a JSON body is not parsed there, and
      // omitting the query param yields "playerId is required".
      await api(`/api/nimiq/wallet?playerId=${encodeURIComponent(playerId)}`, {
        method: "DELETE",
      });
      // Disconnecting is the player's explicit opt-out of auto-connect too —
      // it must never fire again until they link manually.
      forgetWalletAutoConnect(playerId);
      setWallet(null);
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink wallet");
      setPhase("error");
    }
  }, [playerId]);

  return {
    provider: provider.state as NimiqProviderState,
    providerError: provider.error as NimiqWalletError | null,
    recheckProvider: provider.recheck,
    wallet,
    loaded,
    phase,
    error,
    setError,
    link,
    unlink,
    refresh,
  };
}
