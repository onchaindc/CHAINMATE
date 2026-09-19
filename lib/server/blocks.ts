// Server-only module — never import from client components.

/**
 * Player blocks.
 *
 * A block is a one-way shield the BLOCKER holds: the blocked player cannot
 * send the blocker DMs, friend requests, or challenges. It never restricts
 * the blocker's own actions — you can still challenge or message someone you
 * blocked if you change your mind (unblocking restores normal flows).
 *
 * Stored in the same fast game-storage as messages and notification events
 * (one JSON document, write-chained), so it survives restarts exactly like
 * every other moderation record and needs no new database architecture.
 */

import { getGameStorage } from "@/lib/server/storage";

const BLOCKS_KEY = "chainmate:moderation:blocks";

/** player id → list of player ids that player has blocked. */
type BlockMap = Record<string, string[]>;

let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<BlockMap> {
  const raw = await getGameStorage().get(BLOCKS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as BlockMap;
  } catch {
    return {};
  }
}

async function writeAll(map: BlockMap): Promise<void> {
  await getGameStorage().set(BLOCKS_KEY, JSON.stringify(map));
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

/** Block someone. Idempotent; blocks from the other side are separate rows. */
export async function blockPlayer(
  blockerId: string,
  blockedId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!blockerId || !blockedId) return { ok: false, error: "Both players are required" };
  if (blockerId === blockedId) return { ok: false, error: "You cannot block yourself" };
  await withLock(async () => {
    const all = await readAll();
    const mine = all[blockerId] ?? [];
    if (!mine.includes(blockedId)) {
      mine.push(blockedId);
      all[blockerId] = mine;
      await writeAll(all);
    }
  });
  return { ok: true };
}

/** Unblock. Idempotent — unblocking someone who is not blocked succeeds. */
export async function unblockPlayer(
  blockerId: string,
  blockedId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!blockerId || !blockedId) return { ok: false, error: "Both players are required" };
  await withLock(async () => {
    const all = await readAll();
    const mine = all[blockerId];
    if (!mine) return;
    const next = mine.filter((id) => id !== blockedId);
    if (next.length !== mine.length) {
      if (next.length === 0) delete all[blockerId];
      else all[blockerId] = next;
      await writeAll(all);
    }
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Gates — called by the send/request/challenge paths                  */
/* ------------------------------------------------------------------ */

/** Has `blockerId` blocked `blockedId`? One read, cheap on every send. */
export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const all = await readAll();
  return (all[blockerId] ?? []).includes(blockedId);
}

/** ids that `playerId` has blocked (for the UI's own list view). */
export async function blockedByPlayer(playerId: string): Promise<string[]> {
  const all = await readAll();
  return all[playerId] ?? [];
}

/**
 * The gate for outbound actions: returns false when the TARGET has blocked
 * the actor. A blocked player's DM, friend request or challenge dies here —
 * server-side, so a crafted POST cannot reach the target either way. The
 * caller decides the error copy (a challenge says "unavailable", a DM can
 * say "blocked") — or stays deliberately vague.
 */
export async function actorIsBlockedBy(
  actorId: string,
  targetId: string,
): Promise<boolean> {
  return isBlocked(targetId, actorId);
}
