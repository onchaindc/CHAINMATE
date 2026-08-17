import { NextRequest, NextResponse } from "next/server";
import { cancelSeek } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** POST /api/matchmaking/cancel { playerId } — leave the seek pool. */
export async function POST(req: NextRequest) {
  let body: { playerId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  try {
    await cancelSeek(playerId);
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
