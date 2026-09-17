// Server-only module — never import from client components.

/**
 * ChainMate admin layer.
 *
 * Identity: the operator (you) is named by the ADMIN_USERNAMES environment
 * variable (comma-separated, case-insensitive). An admin is any signed-in
 * account whose username matches — resolveActingPlayer already guarantees
 * the playerId belongs to a real session, so a guest can never claim a
 * name. Leave the variable unset and nobody is an admin: every admin route
 * fails closed with 404-style "unknown endpoint" wording.
 *
 * Bans: a fast-store map (same idiom as the Nimiq binding store) keyed by
 * playerId. Enforcement points are the tournament create/join/paid-entry
 * routes — the doors a banned player would walk through. Bans are
 * administrative, not money state: leaving a tournament or finishing a game
 * already in flight is untouched.
 */

import { getGameStorage } from "@/lib/server/storage";
import { profileForPlayerId } from "@/lib/supabase/db";

const BANS_KEY = "chainmate:admin:bans";

export interface BanRecord {
  playerId: string;
  /** Admin-set reason, shown to the player when they hit a door. */
  reason: string;
  bannedAt: number;
  bannedBy: string;
}

function adminUsernames(): string[] {
  return (process.env.ADMIN_USERNAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Resolve a playerId to a signed-in username (null for guests/unknowns). */
export async function usernameForPlayer(playerId: string): Promise<string | null> {
  if (!playerId) return null;
  try {
    const profile = await profileForPlayerId(playerId);
    if (!profile || profile.is_guest) return null;
    return profile.username ?? null;
  } catch {
    return null;
  }
}

/** True when this playerId belongs to a configured admin account. */
export async function isAdminPlayer(playerId: string): Promise<boolean> {
  const username = await usernameForPlayer(playerId);
  if (!username) return false;
  return adminUsernames().includes(username.toLowerCase());
}

export interface AdminGuard {
  ok: boolean;
  playerId?: string;
  error?: string;
  status?: number;
}

/**
 * Guard for /api/admin routes: authenticate through the standard identity
 * path first, then require the admin flag. Fails closed.
 */
export async function requireAdmin(
  playerId: string,
): Promise<AdminGuard> {
  if (!playerId) {
    return { ok: false, error: "playerId is required", status: 400 };
  }
  const isAdmin = await isAdminPlayer(playerId);
  if (!isAdmin) {
    return { ok: false, error: "Not found", status: 404 };
  }
  return { ok: true, playerId };
}

/* ------------------------------------------------------------------ */
/* Ban store                                                           */
/* ------------------------------------------------------------------ */

async function readBans(): Promise<Record<string, BanRecord>> {
  const raw = await getGameStorage().get(BANS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, BanRecord>;
  } catch {
    return {};
  }
}

/** Serialise ban-map writes the same way the tx-consumption map does. */
let banWriteChain: Promise<unknown> = Promise.resolve();
function withBanLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = banWriteChain.then(fn, fn);
  banWriteChain = run.catch(() => undefined);
  return run;
}

export async function getBan(playerId: string): Promise<BanRecord | null> {
  const bans = await readBans();
  return bans[playerId] ?? null;
}

export async function listBans(): Promise<BanRecord[]> {
  const bans = await readBans();
  return Object.values(bans).sort((a, b) => b.bannedAt - a.bannedAt);
}

export async function banPlayer(
  playerId: string,
  reason: string,
  bannedBy: string,
): Promise<BanRecord> {
  return withBanLock(async () => {
    const bans = await readBans();
    const record: BanRecord = {
      playerId,
      reason: reason.trim() || "No reason given",
      bannedAt: Date.now(),
      bannedBy,
    };
    bans[playerId] = record;
    await getGameStorage().set(BANS_KEY, JSON.stringify(bans));
    return record;
  });
}

export async function unbanPlayer(playerId: string): Promise<boolean> {
  return withBanLock(async () => {
    const bans = await readBans();
    if (!bans[playerId]) return false;
    delete bans[playerId];
    await getGameStorage().set(BANS_KEY, JSON.stringify(bans));
    return true;
  });
}

export interface BanGate {
  ok: boolean;
  error?: string;
}

/** Enforcement door: reject when this player is banned. */
export async function requireNotBanned(playerId: string): Promise<BanGate> {
  const ban = await getBan(playerId);
  if (!ban) return { ok: true };
  return {
    ok: false,
    error: `Your account is restricted by a ChainMate administrator. Reason: ${ban.reason}. Contact support if you believe this is a mistake.`,
  };
}
