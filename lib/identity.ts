/**
 * Client-side identity storage (plain TS — safe to import from stores).
 *
 * Two records live in localStorage:
 *  - chainmate:identity:v1 — the persistent per-device player identity.
 *    Every visitor gets one automatically (a guest), so games, rating and
 *    history are tied to a stable id across refreshes and tabs.
 *  - chainmate:auth:v1     — the signed-in Supabase account when present.
 *
 * Guest progress is never destroyed: creating an account links the SAME
 * player id (and therefore games, rating, streaks and achievements) to the
 * new account instead of starting a second identity.
 */

import { HOSTED_PLAYER_KEY } from "@/lib/config";
import { randomHex } from "@/lib/utils";

const GUEST_KEY = "chainmate:identity:v1";
const AUTH_KEY = "chainmate:auth:v1";

export interface GuestIdentity {
  playerId: string;
  username: string;
  isGuest: true;
  createdAt: number;
}

export interface AuthIdentity {
  userId: string;
  /** The account's permanent player id (== the device guest id on upgrade). */
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
 * The per-device player identity. Created on first use and reused forever,
 * so a refresh or a new tab keeps the same player (and their games).
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
