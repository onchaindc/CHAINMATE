"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { supabaseClientConfigured } from "@/lib/supabase/config";
import {
  clearAuthIdentity,
  getAuthIdentity,
  getGuestIdentity,
  setAuthIdentity,
} from "@/lib/identity";

export type IdentityStatus = "loading" | "guest" | "user";

export interface IdentityState {
  status: IdentityStatus;
  /** The active player id (account id when signed in, device guest otherwise). */
  playerId: string;
  username: string;
  rating: number | null;
  isGuest: boolean;
  /**
   * False when authenticated but no `profiles` row exists for this account.
   * Profile edits cannot persist in that state, so the UI should prompt the
   * user to finish setup rather than showing an editable-looking placeholder.
   */
  linked: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const IdentityContext = createContext<IdentityState | null>(null);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<IdentityStatus>("loading");
  const [playerId, setPlayerId] = useState("");
  const [username, setUsername] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [linked, setLinked] = useState(true);

  const refresh = useCallback(async () => {
    const guest = getGuestIdentity();
    const auth = getAuthIdentity();
    const basePlayerId = auth?.playerId ?? guest.playerId;

    setPlayerId(basePlayerId);
    setUsername(auth?.username ?? guest.username);
    setStatus(auth ? "user" : "guest");

    // Re-validate a stored session so expired tokens drop back to guest.
    if (auth) {
      try {
        const res = await fetch("/api/identity/status", {
          headers: auth.accessToken
            ? { Authorization: `Bearer ${auth.accessToken}` }
            : undefined,
        });
        const data = (await res.json()) as {
          authenticated?: boolean;
          linked?: boolean;
          username?: string | null;
          playerId?: string | null;
        };
        if (data.authenticated) {
          const nextPlayerId = data.playerId ?? basePlayerId;
          // Never invent a display name. A literal "Player" here masked the
          // unlinked state as a real username — and because it was persisted
          // below, it stuck across reloads and looked like a failed rename.
          const nextUsername = data.username ?? auth.username ?? "";
          const isLinked = data.linked !== false;
          setPlayerId(nextPlayerId);
          setUsername(nextUsername);
          setLinked(isLinked);
          setStatus("user");
          setAuthIdentity({
            userId: auth.userId,
            playerId: nextPlayerId,
            username: nextUsername,
            rating: auth.rating,
            accessToken: auth.accessToken,
          });
        } else {
          clearAuthIdentity();
          const g = getGuestIdentity();
          setStatus("guest");
          setPlayerId(g.playerId);
          setUsername(g.username);
          // Guests have no account to link; don't leave the flag false.
          setLinked(true);
        }
      } catch {
        // Network hiccup — keep the stored identity; nothing to do.
      }
    }

    // Live rating from the server store (real ELO, server-computed).
    try {
      const res = await fetch(
        `/api/hosted/players/me?playerId=${encodeURIComponent(basePlayerId)}`,
      );
      const data = (await res.json()) as { stats?: { rating: number } };
      if (data.stats) setRating(data.stats.rating);
    } catch {
      // ignore — rating chip just stays hidden
    }
  }, []);

  useEffect(() => {
    void refresh();

    if (!supabaseClientConfigured()) return;

    const sb = getSupabaseBrowser();
    if (!sb) return;

    const { data } = sb.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session) {
        // Preserve any existing profile data — don't clobber the playerId
        // or username that refresh() previously resolved from the server.
        const existing = getAuthIdentity();
        setAuthIdentity({
          userId: session.user.id,
          playerId: existing?.playerId ?? getGuestIdentity().playerId,
          username: existing?.username ?? "",
          rating: existing?.rating ?? 0,
          accessToken: session.access_token,
        });
        await refresh();
      } else if (event === "SIGNED_OUT") {
        clearAuthIdentity();
        await refresh();
      } else if (event === "INITIAL_SESSION" && session) {
        // Page load / refresh: restore the session.
        const existing = getAuthIdentity();
        if (!existing || existing.accessToken !== session.access_token) {
          setAuthIdentity({
            userId: session.user.id,
            playerId: getGuestIdentity().playerId,
            username: existing?.username ?? "",
            rating: existing?.rating ?? 0,
            accessToken: session.access_token,
          });
          await refresh();
        }
      }
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      const sb = getSupabaseBrowser();
      if (sb) await sb.auth.signOut();
    } catch {
      // continue — local record cleared regardless
    }
    clearAuthIdentity();
    await refresh();
  }, [refresh]);

  return (
    <IdentityContext.Provider
      value={{
        status,
        playerId,
        username,
        rating,
        isGuest: status === "guest",
        linked,
        refresh,
        signOut,
      }}
    >
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity(): IdentityState {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used inside IdentityProvider");
  return ctx;
}
