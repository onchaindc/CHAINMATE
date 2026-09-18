import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  dmAllowedPeers,
  inboxFor,
  inboxForDisplay,
  markBroadcastFeedSeen,
  markInboxRead,
  sendDirectMessage,
  sendSupportMessage,
  unseenFeedFor,
} from "@/lib/server/messages";
import {
  eventsFor,
  markEventsRead,
  unreadEventCount,
} from "@/lib/server/notify";

export const runtime = "nodejs";

/**
 * Player messages — GET the inbox, POST to send.
 *
 * GET  /api/messages?playerId=…            → my inbox + unread count
 * POST { playerId, action: "send", toPlayerId?, body }
 *      → "toPlayerId" absent writes to the SUPPORT stream (player → operator)
 * POST { playerId, action: "read" }        → mark my inbox read
 *
 * Delivery to a real recipient is enforced server-side: the target must
 * resolve to a registered account (never a raw invented id).
 */

interface MessageBody {
  playerId?: string;
  action?: "send" | "read" | "read-feed" | "read-dm" | "read-events";
  toPlayerId?: string;
  body?: string;
}

export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  // Optional ?threadWith=<playerId>: only the DM exchange with that player.
  const threadWith = req.nextUrl.searchParams.get("threadWith") ?? "";
  try {
    // The display inbox: every envelope carries a RESOLVED counterpart name,
    // so no client can ever render a raw acct_… player id (the leak the
    // operator reported). Feed copies are only the announcements this account
    // has not laid eyes on yet (past the seen-watermark), so the bell counts
    // them exactly once per player.
    const [ownDisplay, feed] = await Promise.all([
      inboxForDisplay(acting.playerId),
      threadWith ? Promise.resolve([]) : unseenFeedFor(acting.playerId),
    ]);
    const own: (typeof ownDisplay[number] | (typeof feed)[number])[] = ownDisplay;
    const merged = [...own, ...feed]
      .filter((m) =>
        threadWith
          ? (m.kind === "dm" || m.kind === "broadcast") &&
            (m.fromPlayerId === threadWith ||
              (m.kind === "dm" && Boolean(threadWith)))
          : true,
      )
      .sort((a, b) => b.sentAt - a.sentAt);
    const unread = merged.filter((m) => m.readAt === null).length;
    // Notification events (friend requests, accepted requests, challenges):
    // the bell badge counts them; the bell body lists them.
    const [events, eventUnread] = await Promise.all([
      threadWith ? Promise.resolve([]) : eventsFor(acting.playerId),
      unreadEventCount(acting.playerId),
    ]);
    // The friends this account may chat with. The UI filters search results
    // and the chat list through it; the SEND path enforces it independently.
    const allowedPeers = threadWith ? [] : [...(await dmAllowedPeers(acting.playerId))];
    return NextResponse.json({ messages: merged, unread, allowedPeers, events, eventUnread });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load messages";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: MessageBody;
  try {
    body = (await req.json()) as MessageBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  /* Read actions are split so the two badges clear independently:
     "read-feed" marks announcements seen (the bell), "read-dm" marks the
     DM inbox read (opening a chat thread), "read" does both. */
  if (body.action === "read-feed" || body.action === "read") {
    // Feed-only copies (broadcasts this account never received directly)
    // are marked read by remembering the player saw the feed. Persisted as
    // a per-player watermark so the bell stops counting them.
    await markBroadcastFeedSeen(acting.playerId);
    if (body.action === "read") {
      await markInboxRead(acting.playerId);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "read-dm") {
    await markInboxRead(acting.playerId);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "read-events") {
    await markEventsRead(acting.playerId);
    return NextResponse.json({ ok: true });
  }

  if (body.action !== "send") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  try {
    const text = typeof body.body === "string" ? body.body : "";
    const to = (body.toPlayerId ?? "").trim();
    // No explicit recipient: this is a support message to the operator.
    const res = to
      ? await sendDirectMessage(acting.playerId, to, text)
      : await sendSupportMessage(acting.playerId, text);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
