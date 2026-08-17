import { NextRequest, NextResponse } from "next/server";
import { seekMatch } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** POST /api/matchmaking/seek { playerId, timeControl? } */
export async function POST(req: NextRequest) {
  let body: { playerId?: string; timeControl?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) {
    return NextResponse.json(
      { error: "playerId is required — send your browser's player identity" },
      { status: 400 },
    );
  }
  try {
    const result = await seekMatch(playerId, body.timeControl);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to find an opponent";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
