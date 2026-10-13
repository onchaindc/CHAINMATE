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
 * What to show for a player with no real name: the single word "Guest".
 * Alone. No numbers, no suffix, nothing derived from an id — earlier
 * versions minted person-like handles ("ZestyPanda66") and then numbered
 * ones ("Guest 4821"), and both read as users the app had fabricated. A
 * guest is a guest; the word says exactly what they are.
 *
 * The stored `username` still carries a machine-minted `Guest_XXXX` because
 * profiles_username_lower_idx (0001_init.sql:36) is a global unique index
 * that guest rows share — but that value is an internal uniqueness
 * artifact, never a name anyone chose, and it displays as the plain word.
 * Real usernames pass through verbatim, untouched.
 */

/** The one word every guest displays as — alone, never with numbers. */
export const GUEST_NAME = "Guest";

/**
 * Every machine-minted guest artifact the app has ever stored: the device
 * mint `Guest_7B`, the profile mirror `Guest_0X12`, and the bare word
 * itself. Real usernames ("Guesthunter", "AbdulXBT") never match.
 */
const GUEST_ARTIFACT = /^Guest(?:_[0-9A-Za-z]{1,12})?$/;

export function guestDisplayName(username?: string | null): string {
  if (!username) return "";
  return GUEST_ARTIFACT.test(username) ? GUEST_NAME : username;
}

/**
 * Display names are the free-form layer: unlike usernames they may hold any
 * characters — spaces, emoji, scripts that don't share an alphabet with the
 * keyboard layout. The only rules are honesty rules, not identity rules:
 *
 *  1–30 visible code points (counted per code point, so emoji survive),
 *  no control characters, no line breaks — and nothing else. A display
 *  name is never unique and never URL-addressable; the username keeps
 *  those jobs. Empty (after trimming) means "clear my display name".
 */
export const DISPLAY_NAME_MAX = 30;

/** Returns true when useable; false values are for the settings UI locally. */
export function isValidDisplayName(value: string): boolean {
  const chars = Array.from(value.trim()).map((c) => c.codePointAt(0)!);
  if (chars.length < 1 || chars.length > DISPLAY_NAME_MAX) return false;
  // Control/format characters only (U+0000–001F, U+007F–009F) are banned —
  // everything else, including emoji and combining marks, belongs.
  return chars.every((x) => x > 0x1f && (x < 0x7f || x > 0x9f));
}

/**
 * No derived labels exist anymore. Kept only as a tombstone so any leftover
 * caller compiles and renders nothing — never a name.
 * @deprecated
 */
export function playerHandle(): string {
  return "";
}

/**
 * The display name for a PLAYER ID in a row or list: the recorded username
 * verbatim when it is a real name, the plain word "Guest" when it is a
 * machine-minted artifact, and an empty string when nothing was recorded —
 * the caller decides what a blank slot looks like (usually "—").
 */
export function displayNameFor(
  playerId: string | null | undefined,
  username?: string | null,
): string {
  return guestDisplayName(username);
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
  /** Optional free-form display name (presentational only; see 0019). */
  displayName?: string | null;
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
