import { NextResponse } from "next/server";
import { createGameOnChain } from "@/lib/server/genlayer";

export const runtime = "nodejs";

/** POST /api/games — create a new game (deploys a ChainMate contract). */
export async function POST() {
  try {
    const { game, myId } = await createGameOnChain();
    return NextResponse.json({ game, myId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create game";
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
