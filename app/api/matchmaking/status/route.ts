import { NextRequest, NextResponse } from "next/server";
import { pollSeek } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** GET /api/matchmaking/status?playerId=…&timeControl=… — did a pairing appear yet? */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId") ?? "";
  // The poll re-registers the player when they've fallen out of the pool, so it
  // needs the time control they're searching for.
  const timeControl = req.nextUrl.searchParams.get("timeControl") ?? undefined;
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  try {
    const result = await pollSeek(playerId, timeControl);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check matchmaking";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
