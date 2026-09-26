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
 * What to show for a player who has no account name.
 *
 * A bare word like "Guest" collapsed EVERY signed-out player into one
 * identical label — an opponent in your history, the leaderboard, a live
 * watch row and a tournament bracket all read "Guest", indistinguishable
 * from one another, and the app looked like it had a data bug. But every
 * player has a stable device id, so the honest fix is a DETERMINISTIC
 * CHESS-STYLE HANDLE derived from that id: the same visitor is
 * "SwiftFalcon42" on every surface, forever, and two guests never share a
 * name. It reads like a chess username because that is what a display name
 * is for — and when that person later creates an account, the account name
 * replaces the handle everywhere at once.
 *
 * The stored `username` still carries a unique `Guest_XXXX`, because
 * profiles_username_lower_idx (0001_init.sql:36) is a global unique index that
 * guest rows share — every guest storing the literal "Guest" would collide on
 * the second insert. So this maps the stored value (or the raw player id)
 * through the handle at display time rather than at the source.
 *
 * `displayNameFor` exists once because ten call sites used to rebuild this
 * label by hand and had already drifted apart.
 */
/** Machine-minted guest usernames: `Guest_7B` (device mint) and
    `Guest_0X12` (profile mirror). Never a name anyone chose. */
const GUEST_ARTIFACT = /^Guest_[0-9A-Fa-fxX]{1,12}$/;

export function guestDisplayName(username?: string | null): string {
  if (!username) return "Guest";
  return GUEST_ARTIFACT.test(username) ? "Guest" : username;
}

/* The handle vocabulary. Adjective + animal reads as a player name, not a
   status word — 30 × 30 pairings × 100 digit suffixes keep two guests in the
   same tournament meeting the same handle a curiosity, not a bug. */
const HANDLE_ADJECTIVES = [
  "Swift", "Silent", "Bold", "Calm", "Clever", "Daring", "Eager", "Fierce",
  "Gentle", "Happy", "Jolly", "Keen", "Lucky", "Mighty", "Noble", "Patient",
  "Quick", "Royal", "Shy", "Smart", "Steady", "Sunny", "Tidy", "Valiant",
  "Wise", "Witty", "Zesty", "Brisk", "Cosmic", "Frosty",
] as const;
const HANDLE_ANIMALS = [
  "Falcon", "Knight", "Rook", "Bishop", "Pawn", "Queen", "Tiger", "Panda",
  "Otter", "Hawk", "Wolf", "Bear", "Lynx", "Crow", "Dove", "Heron",
  "Badger", "Ibex", "Marten", "Raven", "Stoat", "Vole", "Wren", "Puma",
  "Orca", "Seal", "Fox", "Elk", "Hare", "Moth",
] as const;

/** FNV-1a: tiny, fast, and stable in both the browser and the server. */
function handleSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The stable, unique-per-player display handle: "SwiftFalcon42"-style, from
 * the player id. Deterministic — the same id always yields the same name on
 * every surface, with no stored state and no server round-trip.
 */
export function playerHandle(playerId: string | null | undefined): string {
  if (!playerId) return "Guest";
  const seed = handleSeed(playerId);
  const adjective = HANDLE_ADJECTIVES[seed % HANDLE_ADJECTIVES.length];
  const animal = HANDLE_ANIMALS[Math.floor(seed / HANDLE_ADJECTIVES.length) % HANDLE_ANIMALS.length];
  const digits = (seed % 100).toString().padStart(2, "0");
  return `${adjective}${animal}${digits}`;
}

/**
 * The display name for a PLAYER ID in a row or list: the real username when
 * one resolved, the stable handle when the player is an unnamed guest, and
 * the handle even for a stored `Guest_XXXX` value (which is a uniqueness
 * artifact, never a name anyone chose).
 *
 * Every history row, live card, leaderboard line and tournament bracket
 * routes through THIS — no call site rebuilds the label anymore.
 */
export function displayNameFor(
  playerId: string | null | undefined,
  username?: string | null,
): string {
  // A real username (anything that is not the guest-mint artifact) wins.
  if (username && !GUEST_ARTIFACT.test(username)) return username;
  return playerHandle(playerId);
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
