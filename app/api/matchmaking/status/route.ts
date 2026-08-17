import { NextRequest, NextResponse } from "next/server";
import { pollSeek } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** GET /api/matchmaking/status?playerId=… — did a pairing appear yet? */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId") ?? "";
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  try {
    const result = await pollSeek(playerId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check matchmaking";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
