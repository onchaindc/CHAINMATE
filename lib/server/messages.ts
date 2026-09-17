// Server-only module — never import from client components.

/**
 * Player messages: DMs, the support inbox, and admin broadcasts.
 *
 * One store, three producers: a player replying to a player (DM), a player
 * writing to the operator (support), and the operator writing to everyone
 * (broadcast). Each player has ONE durable inbox — a list of envelopes —
 * which keeps every consumer simple: the nav bell counts unread, the profile
 * messages panel lists and replies, and the admin dashboard reads the
 * support stream and sends broadcasts. Nothing here is transient UI state;
 * envelopes survive restarts like every other fast-store record.
 *
 * The official ChainMate account is not a row in the profiles table: its
 * identity is the literal sender id "chainmate", rendered distinctly in the
 * UI. Broadcasts address every REGISTERED (non-guest) player at send time.
 */

import { getGameStorage } from "@/lib/server/storage";
import { usernameForPlayer } from "@/lib/server/admin";

const MESSAGES_KEY = "chainmate:messages:inboxes";
const CHAINMATE_ID = "chainmate";

export const OFFICIAL_ACCOUNT_ID = CHAINMATE_ID;

export interface MessageEnvelope {
  id: string;
  fromPlayerId: string;
  fromName: string;
  /** "dm" player-to-player · "support" player→operator · "broadcast" operator→all. */
  kind: "dm" | "support" | "broadcast";
  body: string;
  sentAt: number;
  readAt: number | null;
}

type InboxMap = Record<string, MessageEnvelope[]>;

let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<InboxMap> {
  const raw = await getGameStorage().get(MESSAGES_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InboxMap;
  } catch {
    return {};
  }
}

async function writeAll(map: InboxMap): Promise<void> {
  await getGameStorage().set(MESSAGES_KEY, JSON.stringify(map));
}

/** Per-inbox cap: the newest 200 envelopes survive; older fall off. */
const INBOX_LIMIT = 200;

let seq = 0;
function newId(): string {
  seq += 1;
  return `msg_${Date.now().toString(36)}_${seq.toString(36)}`;
}

async function push(playerId: string, envelope: MessageEnvelope): Promise<void> {
  const all = await readAll();
  const inbox = all[playerId] ?? [];
  inbox.unshift(envelope);
  all[playerId] = inbox.slice(0, INBOX_LIMIT);
  await writeAll(all);
}

/** Resolve a display name; the official account renders as ChainMate. */
async function displayNameFor(playerId: string): Promise<string> {
  if (playerId === CHAINMATE_ID) return "ChainMate";
  return (await usernameForPlayer(playerId)) ?? "Player";
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function inboxFor(playerId: string): Promise<MessageEnvelope[]> {
  const all = await readAll();
  return all[playerId] ?? [];
}

export async function unreadCount(playerId: string): Promise<number> {
  const inbox = await inboxFor(playerId);
  return inbox.filter((m) => m.readAt === null).length;
}

export async function markInboxRead(playerId: string): Promise<void> {
  await withLock(async () => {
    const all = await readAll();
    const inbox = all[playerId];
    if (!inbox) return;
    const now = Date.now();
    let changed = false;
    for (const m of inbox) {
      if (m.readAt === null) {
        m.readAt = now;
        changed = true;
      }
    }
    if (changed) await writeAll(all);
  });
}

/* ------------------------------------------------------------------ */
/* Sends                                                               */
/* ------------------------------------------------------------------ */

export async function sendDirectMessage(
  fromPlayerId: string,
  toPlayerId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const text = body.trim();
  if (!text) return { ok: false, error: "Message is empty" };
  if (text.length > 2000) return { ok: false, error: "Message is too long (2000 characters max)" };
  if (fromPlayerId === toPlayerId) return { ok: false, error: "You cannot message yourself" };
  await push(toPlayerId, {
    id: newId(),
    fromPlayerId,
    fromName: await displayNameFor(fromPlayerId),
    kind: "dm",
    body: text,
    sentAt: Date.now(),
    readAt: null,
  });
  return { ok: true };
}

/** A player writing to the operator — lands in the support inbox. */
export async function sendSupportMessage(
  fromPlayerId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const text = body.trim();
  if (!text) return { ok: false, error: "Message is empty" };
  if (text.length > 2000) return { ok: false, error: "Message is too long (2000 characters max)" };
  await push(CHAINMATE_ID, {
    id: newId(),
    fromPlayerId,
    fromName: await displayNameFor(fromPlayerId),
    kind: "support",
    body: text,
    sentAt: Date.now(),
    readAt: null,
  });
  return { ok: true };
}

/** Every registered (non-guest) player id — the broadcast audience. */
async function audiencePlayerIds(): Promise<string[]> {
  const { listRegisteredPlayerIds } = await import("@/lib/supabase/db");
  return listRegisteredPlayerIds();
}

/**
 * The official ChainMate account writes to everyone at once (or to one
 * player). Each recipient gets their own envelope in their own inbox.
 */
export async function sendBroadcast(
  adminPlayerId: string,
  body: string,
  toPlayerId?: string,
): Promise<{ ok: true; recipients: number } | { ok: false; error: string }> {
  const { isAdminPlayer } = await import("@/lib/server/admin");
  if (!(await isAdminPlayer(adminPlayerId))) {
    return { ok: false, error: "Not found" };
  }
  const text = body.trim();
  if (!text) return { ok: false, error: "Message is empty" };
  if (text.length > 2000) return { ok: false, error: "Message is too long (2000 characters max)" };

  const targets = toPlayerId ? [toPlayerId] : await audiencePlayerIds();
  const all = await readAll();
  const now = Date.now();
  for (const tid of targets) {
    if (tid === adminPlayerId && !toPlayerId) continue;
    const inbox = all[tid] ?? [];
    inbox.unshift({
      id: newId(),
      fromPlayerId: CHAINMATE_ID,
      fromName: "ChainMate",
      kind: "broadcast",
      body: text,
      sentAt: now,
      readAt: null,
    });
    all[tid] = inbox.slice(0, INBOX_LIMIT);
  }
  await writeAll(all);
  return { ok: true, recipients: targets.length };
}

/**
 * The operator's support stream: everything players sent TO ChainMate.
 * Admin-only, resolved against the same inbox store.
 */
export async function supportInbox(
  adminPlayerId: string,
): Promise<{ ok: true; messages: MessageEnvelope[] } | { ok: false; error: string }> {
  const { isAdminPlayer } = await import("@/lib/server/admin");
  if (!(await isAdminPlayer(adminPlayerId))) {
    return { ok: false, error: "Not found" };
  }
  return { ok: true, messages: await inboxFor(CHAINMATE_ID) };
}

/** The operator replies to a support message as the official account. */
export async function replyToSupportMessage(
  adminPlayerId: string,
  toPlayerId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { isAdminPlayer } = await import("@/lib/server/admin");
  if (!(await isAdminPlayer(adminPlayerId))) {
    return { ok: false, error: "Not found" };
  }
  return sendDirectMessage(CHAINMATE_ID, toPlayerId, body);
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

/** Total registered accounts on the app — the admin headline number. */
export async function totalRegisteredUsers(): Promise<number> {
  const { countRegisteredPlayers } = await import("@/lib/supabase/db");
  return countRegisteredPlayers();
}
