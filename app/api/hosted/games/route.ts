import { NextRequest, NextResponse } from "next/server";
import { createHostedGame } from "@/lib/server/hosted";

export const runtime = "nodejs";

interface CreateBody {
  playerId?: string;
}

/** POST /api/hosted/games — create a shared multiplayer game. */
export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
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
    const game = await createHostedGame(playerId);
    return NextResponse.json({ game });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create game";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
