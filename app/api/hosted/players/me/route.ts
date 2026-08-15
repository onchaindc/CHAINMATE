import { NextRequest, NextResponse } from "next/server";
import { getPlayerProfile } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** GET /api/hosted/players/me?playerId=… — stats + recent games for one player. */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId");
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  try {
    const profile = await getPlayerProfile(playerId);
    return NextResponse.json(profile);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
