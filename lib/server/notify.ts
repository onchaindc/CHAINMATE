// Server-only module — never import from client components.

/**
 * Notification events: the things that happen TO a player and deserve a bell.
 *
 * Distinct from the message inbox on purpose. A friend request is not a
 * message; it is an action waiting on you. Envelopes here are short, typed,
 * and link somewhere: the bell badge counts them, opening the bell marks them
 * read, and tapping one navigates. Kept tiny and capped per player so the
 * read is one JSON.parse away, same durability model as the message inboxes.
 */

import { getGameStorage } from "@/lib/server/storage";
import { usernameForPlayer } from "@/lib/server/admin";

const EVENTS_KEY = "chainmate:notify:events";
/** Per-inbox cap: the newest 40 events survive; older fall off. */
const EVENT_LIMIT = 40;

export type NotifyEventType =
  | "friend-request"
  | "friend-accepted"
  | "challenge"
  | "message";

export interface NotifyEvent {
  id: string;
  toPlayerId: string;
  type: NotifyEventType;
  /** Who caused it — rendered as the row's avatar and name. */
  actorPlayerId: string;
  actorName: string;
  /** One human sentence, no trailing dot games. */
  body: string;
  /** Where tapping the event goes (app path). */
  href?: string;
  createdAt: number;
  readAt: number | null;
}

type EventMap = Record<string, NotifyEvent[]>;

let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readAll(): Promise<EventMap> {
  const raw = await getGameStorage().get(EVENTS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EventMap;
  } catch {
    return {};
  }
}

async function writeAll(map: EventMap): Promise<void> {
  await getGameStorage().set(EVENTS_KEY, JSON.stringify(map));
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `evt_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * Best display name for the actor (falls back without leaking raw ids).
 * The app has exactly three names for unresolvable players: "ChainMate"
 * (the official account — it has no profile row by design), "CM Grandmaster"
 * (the bots' shared brand), and "Guest" (everywhere else). Nothing invented.
 */
async function actorDisplayName(playerId: string): Promise<string> {
  if (playerId === "chainmate") return "ChainMate";
  return (await usernameForPlayer(playerId)) ?? "Guest";
}

/**
 * Where a tap on the actor's identity should land: their PUBLIC profile.
 * The old friend-request rows pointed at `/profile` — the RECIPIENT's own
 * profile — so "User A sent you a friend request" opened… you. Every social
 * event now names the actor's page (guests and unresolvable actors fall
 * back to the app home rather than a broken link).
 */
async function actorProfileHref(playerId: string): Promise<string> {
  if (playerId === "chainmate") return "/messages";
  const username = await usernameForPlayer(playerId);
  return username ? `/players/${encodeURIComponent(username)}` : "/";
}

/**
 * Read-time repair: notification bodies were persisted with whatever name
 * the actor resolved to AT SEND TIME — including the era when an unnamed
 * actor produced "A player challenged you…" (the exact wording the operator
 * reported). Re-derive the actor's CURRENT name on every read and rebuild
 * the sentence when it differs. Rows for the official account heal to
 * "ChainMate …" without a store rewrite.
 */
function rebuildEventBody(type: NotifyEventType, name: string, oldBody: string): string {
  if (type === "message") return oldBody; // body IS the message preview
  const lower = oldBody.toLowerCase();
  if (type === "friend-request") {
    return lower.includes("friend request") && !oldBody.startsWith(name)
      ? `${name} sent you a friend request.`
      : oldBody;
  }
  if (type === "friend-accepted") {
    return lower.includes("accepted your friend request") && !oldBody.startsWith(name)
      ? `${name} accepted your friend request. You can chat now.`
      : oldBody;
  }
  if (type === "challenge") {
    return lower.includes("challenged you") && !oldBody.startsWith(name)
      ? `${name} challenged you to a game.`
      : oldBody;
  }
  return oldBody;
}

async function pushEvent(
  event: Omit<NotifyEvent, "id" | "readAt">,
): Promise<void> {
  await withLock(async () => {
    const all = await readAll();
    const inbox = all[event.toPlayerId] ?? [];
    inbox.unshift({ ...event, id: newId(), readAt: null });
    all[event.toPlayerId] = inbox.slice(0, EVENT_LIMIT);
    await writeAll(all);
  });
}

/* ------------------------------------------------------------------ */
/* Producers                                                           */
/* ------------------------------------------------------------------ */

/** Someone asked to be this player's friend. */
export async function notifyFriendRequest(
  requesterId: string,
  addresseeId: string,
): Promise<void> {
  const name = await actorDisplayName(requesterId);
  // Tap target: the REQUESTER's profile — the row is about them, and
  // accepting happens from the profile/friends surfaces it links to.
  await pushEvent({
    toPlayerId: addresseeId,
    type: "friend-request",
    actorPlayerId: requesterId,
    actorName: name,
    body: `${name} sent you a friend request.`,
    href: await actorProfileHref(requesterId),
    createdAt: Date.now(),
  });
}

/** The other side said yes — tell the requester without a refresh. */
export async function notifyFriendAccepted(
  accepterId: string,
  requesterId: string,
): Promise<void> {
  const name = await actorDisplayName(accepterId);
  // Tap target: the ACCEPTER's profile (who accepted), matching the avatar
  // the row already shows — not the reader's own /profile.
  await pushEvent({
    toPlayerId: requesterId,
    type: "friend-accepted",
    actorPlayerId: accepterId,
    actorName: name,
    body: `${name} accepted your friend request. You can chat now.`,
    href: await actorProfileHref(accepterId),
    createdAt: Date.now(),
  });
}

/**
 * A direct message arrived — the bell's bridge to the inbox.
 *
 * EVERY DM now rings the bell, WhatsApp-style: "AbdulXBT sent you a message"
 * with a tap that opens that exact thread (/messages?with=<sender>). Without
 * this, a DM from a player is invisible until the recipient happens to open
 * /messages — the badge lives in the hamburger menu where nobody looks.
 *
 * DEDUP: rapid-fire messages from one sender must read as ONE notification
 * that stays fresh, not a pile of rows. While the recipient has not seen the
 * event yet, a new message from the SAME sender UPDATES that row (body →
 * newest preview, timestamp → now) instead of pushing another. Marking seen
 * (opening the bell) resets the cycle, so the next unseen message after a
 * check rings again. The official account's moderation replies take the
 * same path, body being the message itself.
 */
export async function notifyDirectMessage(
  fromPlayerId: string,
  toPlayerId: string,
  preview: string,
): Promise<void> {
  const name = await actorDisplayName(fromPlayerId);
  await withLock(async () => {
    const all = await readAll();
    const inbox = all[toPlayerId] ?? [];
    // Replace this sender's still-unseen "…sent you a message" row, newest
    // first — one live notification per sender, exactly one badge unit.
    const existing = inbox.find(
      (e) => e.type === "message" && e.actorPlayerId === fromPlayerId && e.readAt === null,
    );
    if (existing) {
      existing.body = preview;
      existing.createdAt = Date.now();
      existing.href = `/messages?with=${encodeURIComponent(fromPlayerId)}`;
      // Bump to the top so the freshest sender leads the panel.
      all[toPlayerId] = [existing, ...inbox.filter((e) => e.id !== existing.id)];
      await writeAll(all);
      return;
    }
    inbox.unshift({
      toPlayerId,
      type: "message",
      actorPlayerId: fromPlayerId,
      actorName: name,
      body: preview,
      href: `/messages?with=${encodeURIComponent(toPlayerId === fromPlayerId ? "" : fromPlayerId)}`,
      createdAt: Date.now(),
      id: newId(),
      readAt: null,
    });
    all[toPlayerId] = inbox.slice(0, EVENT_LIMIT);
    await writeAll(all);
  });
}

/** A direct challenge landed. */
export async function notifyChallenge(
  fromPlayerId: string,
  toPlayerId: string,
  gameId: string,
): Promise<void> {
  const name = await actorDisplayName(fromPlayerId);
  await pushEvent({
    toPlayerId,
    type: "challenge",
    actorPlayerId: fromPlayerId,
    actorName: name,
    body: `${name} challenged you to a game.`,
    href: `/game/${gameId}`,
    createdAt: Date.now(),
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function eventsFor(playerId: string): Promise<NotifyEvent[]> {
  const all = await readAll();
  const inbox = all[playerId] ?? [];
  // Names are stored denormalised but rendered now — heal any row whose
  // stored name no longer matches the actor's current one.
  return Promise.all(
    inbox.map(async (e) => {
      const current = await actorDisplayName(e.actorPlayerId);
      if (current === e.actorName) return e;
      const healed: NotifyEvent = {
        ...e,
        actorName: current,
        body: rebuildEventBody(e.type, current, e.body),
      };
      return healed;
    }),
  );
}

export async function unreadEventCount(playerId: string): Promise<number> {
  const events = await eventsFor(playerId);
  return events.filter((e) => e.readAt === null).length;
}

/** Opening the bell clears the badge: mark every event seen. */
export async function markEventsRead(playerId: string): Promise<void> {
  await withLock(async () => {
    const all = await readAll();
    const inbox = all[playerId];
    if (!inbox) return;
    const now = Date.now();
    let changed = false;
    for (const e of inbox) {
      if (e.readAt === null) {
        e.readAt = now;
        changed = true;
      }
    }
    if (changed) await writeAll(all);
  });
}
