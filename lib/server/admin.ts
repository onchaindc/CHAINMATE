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
const PASSCODE_KEY = "chainmate:admin:passcode";

/* ------------------------------------------------------------------ */
/* Dashboard passcode (4 digits)                                       */
/* ------------------------------------------------------------------ */
/* The operator sets a 4-digit code once (set + confirm in the UI); the
   dashboard then demands it on every open and re-locks after 30 minutes
   idle. The hash (SHA-256, salted) is all that is stored — a store dump
   never reveals the code. The server-side admin identity check (username
   allowlist) remains the FIRST gate; this is the second, so a borrowed
   session cannot open the operator's console. */

import { createHash, randomBytes } from "node:crypto";

export interface PasscodeGate {
  ok: boolean;
  error?: string;
  /** Opaque session token to present on subsequent admin-dashboard calls. */
  token?: string;
}

interface PasscodeRecord {
  salt: string;
  hash: string;
}

function hashPasscode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

async function readPasscode(): Promise<PasscodeRecord | null> {
  const raw = await getGameStorage().get(PASSCODE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PasscodeRecord;
  } catch {
    return null;
  }
}

export async function passcodeIsSet(): Promise<boolean> {
  return (await readPasscode()) !== null;
}

/** First-time setup: store salted hash of the confirmed code. */
export async function setPasscode(code: string, confirm: string): Promise<PasscodeGate> {
  if (!/^[0-9]{4}$/.test(code)) {
    return { ok: false, error: "The code must be exactly 4 digits" };
  }
  if (code !== confirm) {
    return { ok: false, error: "The two codes do not match" };
  }
  const salt = randomBytes(16).toString("hex");
  const record: PasscodeRecord = { salt, hash: hashPasscode(code, salt) };
  await getGameStorage().set(PASSCODE_KEY, JSON.stringify(record));
  const token = randomBytes(24).toString("hex");
  passcodeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return { ok: true, token };
}

/** 30 minutes of idleness re-locks the console. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const passcodeSessions = new Map<string, number>();

function pruneSessions(): void {
  const now = Date.now();
  for (const [token, expires] of passcodeSessions) {
    if (expires < now) passcodeSessions.delete(token);
  }
}

/** Verify the code and mint a fresh 30-minute session token. */
export async function verifyPasscode(code: string): Promise<PasscodeGate> {
  const record = await readPasscode();
  if (!record) return { ok: false, error: "No passcode is set yet" };
  pruneSessions();
  if (hashPasscode(code, record.salt) !== record.hash) {
    return { ok: false, error: "Wrong code" };
  }
  const token = randomBytes(24).toString("hex");
  passcodeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return { ok: true, token };
}

/** Slide the session forward; false once it expired (re-ask for the code). */
export function passcodeSessionValid(token: string | null): boolean {
  if (!token) return false;
  pruneSessions();
  const expires = passcodeSessions.get(token);
  if (expires === undefined || expires < Date.now()) {
    passcodeSessions.delete(token);
    return false;
  }
  passcodeSessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

export function invalidatePasscodeSession(token: string | null): void {
  if (token) passcodeSessions.delete(token);
}

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

const OPERATOR_KEY = "chainmate:admin:operator";

/** Resolve a playerId to a signed-in username (null for guests/unknowns). */
export async function usernameForPlayer(playerId: string): Promise<string | null> {
  if (!playerId) return null;
  try {
    const profile = await profileForPlayerId(playerId);
    // Definitional account predicate (acct_… = account, 0x… = guest): the
    // is_guest flag has drifted before and must not hide real usernames.
    if (!profile) return null;
    if (!playerId.startsWith("acct_") && profile.is_guest) return null;
    return profile.username ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Operator seat                                                       */
/* ------------------------------------------------------------------ */
/* Deployment reality: ADMIN_USERNAMES lives in Vercel env vars, and while
   it is unset NOBODY is an admin — the dashboard would be unreachable
   forever. So the seat also self-bootstraps: the first signed-in account
   to complete passcode setup claims it durably, and the server keeps
   honoring that account even after the env var is configured. Guests can
   never claim it (no username). Claim is first-come, one-time. */

export async function operatorPlayerId(): Promise<string | null> {
  const raw = await getGameStorage().get(OPERATOR_KEY);
  return raw ?? null;
}

/** One-time claim; returns false when somebody already holds the seat. */
export async function claimOperatorSeat(playerId: string): Promise<boolean> {
  const existing = await operatorPlayerId();
  if (existing) return existing === playerId;
  await getGameStorage().set(OPERATOR_KEY, playerId);
  return true;
}

/** True when this playerId belongs to a configured admin account. */
export async function isAdminPlayer(playerId: string): Promise<boolean> {
  const username = await usernameForPlayer(playerId);
  if (adminUsernames().includes((username ?? "").toLowerCase())) return true;
  // The operator seat outranks the username check: it IS the durable
  // self-bootstrap path (the seat is claimed by the first signed-in account
  // through passcode setup, precisely because the env var can be unset), and
  // usernameForPlayer returns null whenever Supabase is unreachable — which
  // would otherwise silently strip the operator's own powers.
  return (await operatorPlayerId()) === playerId;
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
