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
import { isAdminPlayer, usernameForPlayer } from "@/lib/server/admin";
import { listFriendIds, profileForPlayerId } from "@/lib/supabase/db";

const MESSAGES_KEY = "chainmate:messages:inboxes";
const BROADCAST_FEED_KEY = "chainmate:messages:broadcasts";
const CHAINMATE_ID = "chainmate";

export const OFFICIAL_ACCOUNT_ID = CHAINMATE_ID;

export interface MessageEnvelope {
  id: string;
  fromPlayerId: string;
  fromName: string;
  /** Recipient for dm/support envelopes; null for broadcasts. This is what
      lets the sender's own copy group into the right conversation thread. */
  toPlayerId?: string | null;
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

/**
 * The player's inbox with the RAW player id never exposed: every envelope
 * carries a resolved display name for the OTHER side of the exchange, so a
 * client rendering a chat list or thread can never leak an acct_… string
 * (the exact leak the operator reported). The counterpart name is ALWAYS the
 * other side's username, including on the reader's own sent copies: the chat
 * list labels a thread with this name, so "You" here made every conversation
 * the player had initiated render as "You" instead of the friend's username.
 * Which bubbles are the reader's own is already decided by fromPlayerId.
 * Names resolve at read time, which also heals envelopes stored before a
 * player picked a name.
 */
export interface InboxMessage extends MessageEnvelope {
  /** Display name for whoever is NOT the reader (always their username). */
  counterpartName: string;
  /** The other side's player id, for grouping threads. */
  counterpartId: string;
  /** The other side's uploaded picture, for chat-list and bubble avatars. */
  counterpartAvatar?: string | null;
}

export async function inboxForDisplay(playerId: string): Promise<InboxMessage[]> {
  const inbox = await inboxFor(playerId);
  // Resolve each distinct peer once; Supabase lookups are not free and a busy
  // inbox repeats the same handful of players.
  const nameCache = new Map<string, string>();
  const avatarCache = new Map<string, string | null>();
  const peerName = async (peerId: string): Promise<string> => {
    const cached = nameCache.get(peerId);
    if (cached !== undefined) return cached;
    const resolved = (await usernameForPlayer(peerId)) ?? "Player";
    nameCache.set(peerId, resolved);
    return resolved;
  };
  const peerAvatar = async (peerId: string): Promise<string | null> => {
    const cached = avatarCache.get(peerId);
    if (cached !== undefined) return cached;
    let url: string | null = null;
    try {
      const profile = await profileForPlayerId(peerId);
      url = profile?.avatar_url ?? null;
    } catch {
      url = null;
    }
    avatarCache.set(peerId, url);
    return url;
  };
  const out: InboxMessage[] = [];
  for (const m of inbox) {
    if (m.kind === "dm" && m.toPlayerId) {
      const mine = m.fromPlayerId === playerId;
      const peerId = mine ? m.toPlayerId : m.fromPlayerId;
      out.push({
        ...m,
        counterpartId: peerId,
        // Always the peer's real name, own copies included. "You" on this
        // field was the bug: the chat list titles each thread with it, so a
        // chat whose newest message was the reader's own showed "You".
        counterpartName:
          peerId === CHAINMATE_ID ? "ChainMate" : await peerName(peerId),
        counterpartAvatar:
          peerId === CHAINMATE_ID ? null : await peerAvatar(peerId),
      });
      continue;
    }
    // Support + broadcast envelopes: the reader is always the recipient.
    out.push({
      ...m,
      counterpartId: m.fromPlayerId,
      counterpartName: m.fromPlayerId === CHAINMATE_ID ? "ChainMate" : await peerName(m.fromPlayerId),
      counterpartAvatar: m.fromPlayerId === CHAINMATE_ID ? null : await peerAvatar(m.fromPlayerId),
    });
  }
  return out;
}

/**
 * Friends-only DMs. Returns the ids this player may open a conversation
 * with: mutual accepted friendships (either direction of the request),
 * plus the official ChainMate account — a moderation reply or announcement
 * that lands in your inbox must be visible in your thread list, or the
 * player can never answer it (the exact mobile bug: the send gate allows
 * the official account, but this allowlist hid its thread from the list).
 * Guests have no friendships, so they naturally cannot DM until they make
 * an account and add someone.
 */
export async function dmAllowedPeers(playerId: string): Promise<Set<string>> {
  const peers = new Set<string>([CHAINMATE_ID]);
  try {
    const ids = await listFriendIds(playerId);
    for (const id of ids) peers.add(id);
    return peers;
  } catch {
    // Friends are unavailable (accounts not configured): fail CLOSED for the
    // friend gate so a messaging outage never opens DMs to strangers. The
    // official account stays allowed regardless — it is not a stranger.
    return peers;
  }
}

export async function unreadCount(playerId: string): Promise<number> {
  const inbox = await inboxFor(playerId);
  const feed = await broadcastFeedFor(playerId);
  return (
    inbox.filter((m) => m.readAt === null).length + feed.filter((m) => m.readAt === null).length
  );
}

const FEED_SEEN_KEY = "chainmate:messages:feed-seen";

/** Remember that this player has seen the broadcast feed (bell clears). */
export async function markBroadcastFeedSeen(playerId: string): Promise<void> {
  const raw = await getGameStorage().get(FEED_SEEN_KEY);
  let seen: Record<string, number> = {};
  try {
    seen = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    seen = {};
  }
  seen[playerId] = Date.now();
  await getGameStorage().set(FEED_SEEN_KEY, JSON.stringify(seen));
}

/** Feed envelopes newer than the player's last feed-view watermark. */
export async function unseenFeedFor(playerId: string): Promise<MessageEnvelope[]> {
  const raw = await getGameStorage().get(FEED_SEEN_KEY);
  let watermark = 0;
  try {
    const seen = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    watermark = seen[playerId] ?? 0;
  } catch {
    watermark = 0;
  }
  const feed = await broadcastFeedFor(playerId);
  return feed.filter((m) => m.sentAt > watermark);
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
  // The operator (admin) messages anyone — full rights, no friendship
  // required. The OFFICIAL account (ChainMate support replies) carries the
  // same authority: nobody can sign in as it, and gating its replies on its
  // own friendship list is what bounced admin messages with "add them
  // first, then chat". Checked BEFORE the friend gate; see dmAllowedPeers
  // for the fail-closed reasoning behind the gate itself.
  if (fromPlayerId === CHAINMATE_ID || (await isAdminPlayer(fromPlayerId))) {
    // fall through to delivery
  } else {
    // Friends-only DMs, enforced HERE on every send. Server-side, so a
    // crafted POST with an arbitrary toPlayerId can never reach a stranger's
    // inbox.
    const allowed = await dmAllowedPeers(fromPlayerId);
    if (!allowed.has(toPlayerId)) {
      return { ok: false, error: "You can only message players you are friends with. Add them first, then chat." };
    }
  }
  // The recipient's block shield outranks everything else (official account
  // included): a block exists precisely to stop unwanted messages, so the
  // moderation gate is the LAST authority before delivery.
  const { actorIsBlockedBy } = await import("@/lib/server/blocks");
  if (await actorIsBlockedBy(fromPlayerId, toPlayerId)) {
    return { ok: false, error: "You can't message this player." };
  }
  const fromName = await displayNameFor(fromPlayerId);
  const sentAt = Date.now();
  await push(toPlayerId, {
    id: newId(),
    fromPlayerId,
    fromName,
    toPlayerId,
    kind: "dm",
    body: text,
    sentAt,
    readAt: null,
  });
  // The sender keeps their own copy too, pre-read so it never inflates the
  // bell: a thread view needs both directions to render a conversation, and
  // the recipient field on this copy is what files it under the right peer.
  await push(fromPlayerId, {
    id: newId(),
    fromPlayerId,
    fromName,
    toPlayerId,
    kind: "dm",
    body: text,
    sentAt,
    readAt: sentAt,
  });

  // Official/admin outreach rings the bell. A moderation reply that only
  // exists inside /messages is invisible — the player has no reason to open
  // a thread they do not know exists. Ordinary player-to-player DMs stay
  // bell-silent: their badge lives on the Messages entry alone.
  if (fromPlayerId === CHAINMATE_ID) {
    const { notifyDirectMessage } = await import("@/lib/server/notify");
    await notifyDirectMessage(
      fromPlayerId,
      toPlayerId,
      text.length > 80 ? `${text.slice(0, 80)}…` : text,
    ).catch(() => undefined);
  }
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
    toPlayerId: CHAINMATE_ID,
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
  const envelope: MessageEnvelope = {
    id: newId(),
    fromPlayerId: CHAINMATE_ID,
    fromName: "ChainMate",
    kind: "broadcast",
    body: text,
    sentAt: now,
    readAt: null,
  };
  for (const tid of targets) {
    if (tid === adminPlayerId && !toPlayerId) continue;
    const inbox = all[tid] ?? [];
    inbox.unshift({ ...envelope, id: newId() });
    all[tid] = inbox.slice(0, INBOX_LIMIT);
  }
  await writeAll(all);
  // Global feed: broadcasts are ALSO visible to every account the moment it
  // signs in — guests, alts created after the send, and anyone the audience
  // list missed. The feed is capped to the newest 20; read state stays per
  // player (in the inbox copies above) for accounts that received one.
  if (!toPlayerId) {
    const feedRaw = await getGameStorage().get(BROADCAST_FEED_KEY);
    let feed: MessageEnvelope[] = [];
    try {
      feed = feedRaw ? (JSON.parse(feedRaw) as MessageEnvelope[]) : [];
    } catch {
      feed = [];
    }
    feed.unshift({ ...envelope, readAt: null });
    await getGameStorage().set(
      BROADCAST_FEED_KEY,
      JSON.stringify(feed.slice(0, 20)),
    );
  }
  return { ok: true, recipients: targets.length };
}

/**
 * The global announcement feed, merged into any inbox that has not received
 * the broadcast copy directly (accounts created after the send, guests).
 * Already-received envelopes are matched on body+sentAt so nobody sees one
 * announcement twice.
 */
export async function broadcastFeedFor(playerId: string): Promise<MessageEnvelope[]> {
  const feedRaw = await getGameStorage().get(BROADCAST_FEED_KEY);
  let feed: MessageEnvelope[] = [];
  try {
    feed = feedRaw ? (JSON.parse(feedRaw) as MessageEnvelope[]) : [];
  } catch {
    feed = [];
  }
  if (feed.length === 0) return [];
  const own = await inboxFor(playerId);
  const seen = new Set(own.map((m) => `${m.kind}:${m.body}:${m.sentAt}`));
  return feed.filter((m) => !seen.has(`${m.kind}:${m.body}:${m.sentAt}`));
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
  // The envelope is FROM the official ChainMate account, but the permission
  // is the OPERATOR's — checked above. sendDirectMessage must never re-apply
  // the friends gate to ChainMate itself (the old behaviour): an official
  // reply to a player who wasn't (yet) a friend of the ChainMate account
  // bounced with "add them first, then chat", which is exactly the report
  // this module exists to fix.
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
