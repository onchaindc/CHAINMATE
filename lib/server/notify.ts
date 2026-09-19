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
 * (the official account — it has no profile row by design), "Computer"
 * (the engine), and "Guest" (everywhere else). Nothing invented: a
 * notification that says "Someone sent you a friend request" reads like
 * a security breach.
 */
async function actorDisplayName(playerId: string): Promise<string> {
  if (playerId === "chainmate") return "ChainMate";
  return (await usernameForPlayer(playerId)) ?? "Guest";
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
  await pushEvent({
    toPlayerId: addresseeId,
    type: "friend-request",
    actorPlayerId: requesterId,
    actorName: name,
    body: `${name} sent you a friend request.`,
    href: "/profile",
    createdAt: Date.now(),
  });
}

/** The other side said yes — tell the requester without a refresh. */
export async function notifyFriendAccepted(
  accepterId: string,
  requesterId: string,
): Promise<void> {
  const name = await actorDisplayName(accepterId);
  await pushEvent({
    toPlayerId: requesterId,
    type: "friend-accepted",
    actorPlayerId: accepterId,
    actorName: name,
    body: `${name} accepted your friend request. You can chat now.`,
    href: "/messages",
    createdAt: Date.now(),
  });
}

/**
 * A direct message arrived — the bell's bridge to the inbox.
 *
 * Player-to-player DMs deliberately do NOT ring the bell (they count in the
 * Messages badge only); this producer exists for senders whose message would
 * otherwise be invisible until the player happens to open /messages — the
 * official account's moderation replies and admin outreach above all. The
 * body is the message itself, un-prefixed: the row already shows who sent
 * it (avatar + name), and a "ChainMate: Hi onchaindc. This is a final
 * warning…" read like a letter's envelope quoting itself.
 */
export async function notifyDirectMessage(
  fromPlayerId: string,
  toPlayerId: string,
  preview: string,
): Promise<void> {
  const name = await actorDisplayName(fromPlayerId);
  await pushEvent({
    toPlayerId,
    type: "message",
    actorPlayerId: fromPlayerId,
    actorName: name,
    body: preview,
    href: `/messages?with=${encodeURIComponent(toPlayerId === fromPlayerId ? "" : fromPlayerId)}`,
    createdAt: Date.now(),
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
  return all[playerId] ?? [];
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
