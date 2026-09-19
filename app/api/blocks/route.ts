import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { blockPlayer, blockedByPlayer, unblockPlayer } from "@/lib/server/blocks";

export const runtime = "nodejs";

/**
 * Player blocks — the moderation shield.
 *
 * GET  /api/blocks?playerId=…        → the ids this player has blocked
 * POST { playerId, otherId, action } → "block" | "unblock"
 *
 * resolveActingPlayer authenticates the claimed id: nobody can manage
 * someone else's block list. Blocking is one-way and does not notify the
 * other side — a block is a shield, not a message.
 */

interface BlockBody {
  playerId?: string;
  otherId?: string;
  action?: "block" | "unblock";
}

export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  return NextResponse.json({ blocked: await blockedByPlayer(acting.playerId) });
}

export async function POST(req: NextRequest) {
  let body: BlockBody;
  try {
    body = (await req.json()) as BlockBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const otherId = (body.otherId ?? "").trim();
  if (!otherId) {
    return NextResponse.json({ error: "otherId is required" }, { status: 400 });
  }
  const res =
    body.action === "unblock"
      ? await unblockPlayer(acting.playerId, otherId)
      : await blockPlayer(acting.playerId, otherId);
  if (!res.ok) {
    return NextResponse.json({ error: res.error ?? "Failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
