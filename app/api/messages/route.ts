import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  inboxFor,
  markBroadcastFeedSeen,
  markInboxRead,
  sendDirectMessage,
  sendSupportMessage,
  unreadCount,
  unseenFeedFor,
} from "@/lib/server/messages";

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
  action?: "send" | "read";
  toPlayerId?: string;
  body?: string;
}

export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  try {
    const [own, feed] = await Promise.all([
      inboxFor(acting.playerId),
      unseenFeedFor(acting.playerId),
    ]);
    // Merge, newest first. Feed copies are only the announcements this
    // account has not laid eyes on yet (past the seen-watermark), so the
    // bell counts them exactly once per player.
    const merged = [...own, ...feed].sort((a, b) => b.sentAt - a.sentAt);
    const unread = merged.filter((m) => m.readAt === null).length;
    return NextResponse.json({ messages: merged, unread });
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

  if (body.action === "read") {
    await markInboxRead(acting.playerId);
    // Feed-only copies (broadcasts this account never received directly)
    // are marked read by remembering the player saw the feed. Persisted as
    // a per-player watermark so the bell stops counting them.
    await markBroadcastFeedSeen(acting.playerId);
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
