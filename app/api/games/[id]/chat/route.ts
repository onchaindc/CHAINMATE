import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { readGameChat, sendGameChat } from "@/lib/server/game-chat";

export const runtime = "nodejs";

/**
 * In-game chat — participant-only by construction.
 *
 * GET  /api/games/[id]/chat?playerId=…  → my-visible messages for this game
 * POST { playerId, body }               → append one message
 *
 * resolveActingPlayer authenticates the claimed id; the chat module then
 * refuses anyone who is not one of the two players.
 */

interface ChatBody {
  playerId?: string;
  body?: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const res = await readGameChat(id, acting.playerId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ messages: res.messages });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const res = await sendGameChat(id, acting.playerId, body.body ?? "");
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, message: res.message });
}
