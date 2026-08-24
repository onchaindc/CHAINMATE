/**
 * Client-side identity storage (plain TS — safe to import from stores).
 *
 * Two records live in localStorage:
 *  - chainmate:identity:v1 — the per-device player identity. Every visitor
 *    gets one automatically (a guest). The id is stable per device only so a
 *    live hosted game survives a refresh — guest games are casual and never
 *    rated, so no "history" accumulates.
 *  - chainmate:auth:v1     — the signed-in Supabase account when present.
 *
 * Guests are guests: their games never touch ratings, streaks or
 * achievements, and creating an account always starts a fresh 1200 profile —
 * guest history is never merged.
 */

import { HOSTED_PLAYER_KEY } from "@/lib/config";
import { randomHex } from "@/lib/utils";

const GUEST_KEY = "chainmate:identity:v1";
const AUTH_KEY = "chainmate:auth:v1";

/**
 * What to show for a player who has no account name: just "Guest".
 *
 * Every guest is labelled identically on purpose — the user asked for the
 * trailing short id to go. Two guests in one list are therefore
 * indistinguishable, which is the accepted trade.
 *
 * The stored `username` still carries a unique `Guest_XXXX`, because
 * profiles_username_lower_idx (0001_init.sql:36) is a global unique index that
 * guest rows share — every guest storing the literal "Guest" would collide on
 * the second insert. So this strips the suffix at display time rather than at
 * the source, and it exists once because ten call sites used to rebuild this
 * label by hand and had already drifted apart.
 */
export function guestDisplayName(username?: string | null): string {
  if (!username) return "Guest";
  return /^Guest_[0-9A-Fa-f]+$/.test(username) ? "Guest" : username;
}

export interface GuestIdentity {
  playerId: string;
  username: string;
  isGuest: true;
  createdAt: number;
}

export interface AuthIdentity {
  userId: string;
  /** The account's permanent player id (fresh `acct_…` id, never a guest id). */
  playerId: string;
  username: string;
  rating: number;
  accessToken: string;
}

function readJSON<T>(key: string): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) — identity stays in-memory
  }
}

/**
 * The per-device player identity. Created on first use and reused, so a
 * refresh or a new tab keeps the same player while a hosted game is live.
 * Guests stay casual: games are never rated and no stats accumulate.
 * Migrates the pre-identity sessionStorage player id if one exists.
 */
export function getGuestIdentity(): GuestIdentity {
  const existing = readJSON<GuestIdentity>(GUEST_KEY);
  if (existing?.playerId && existing?.username) return existing;

  let playerId = existing?.playerId;
  if (!playerId && typeof sessionStorage !== "undefined") {
    playerId = sessionStorage.getItem(HOSTED_PLAYER_KEY) ?? undefined;
  }
  if (!playerId && typeof localStorage !== "undefined") {
    playerId = localStorage.getItem(HOSTED_PLAYER_KEY) ?? undefined;
  }
  if (!playerId) playerId = `0x${randomHex(20)}`;

  const identity: GuestIdentity = {
    playerId,
    username: `Guest_${randomHex(2).toUpperCase()}`,
    isGuest: true,
    createdAt: Date.now(),
  };
  writeJSON(GUEST_KEY, identity);
  return identity;
}

/** The current signed-in account identity, if any. */
export function getAuthIdentity(): AuthIdentity | null {
  return readJSON<AuthIdentity>(AUTH_KEY);
}

export function setAuthIdentity(auth: AuthIdentity) {
  writeJSON(AUTH_KEY, auth);
}

export function clearAuthIdentity() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore
  }
}

/** Access token for authenticated API calls (or null when signed out). */
export function getIdentityToken(): string | null {
  return getAuthIdentity()?.accessToken ?? null;
}

/** The player id used by the hosted game store. */
export function getPlayerId(): string {
  return getGuestIdentity().playerId;
}

/** The display name for the current player (guest or account). */
export function getPlayerUsername(): string {
  return getAuthIdentity()?.username ?? getGuestIdentity().username;
}
