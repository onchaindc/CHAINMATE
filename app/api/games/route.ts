import { NextRequest, NextResponse } from "next/server";
import { createGameOnChain } from "@/lib/server/genlayer";

export const runtime = "nodejs";

/**
 * POST /api/games { playerId } — create a new game (deploys a ChainMate
 * contract). The creator's app identity is bound to White server-side, so
 * subsequent moves/resignations can never be signed with the opponent's key.
 */
export async function POST(req: NextRequest) {
  let body: { playerId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) {
    return NextResponse.json(
      { error: "playerId is required — send your browser's player identity" },
      { status: 400 },
    );
  }
  try {
    const { game, myId } = await createGameOnChain(playerId);
    return NextResponse.json({ game, myId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create game";
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
