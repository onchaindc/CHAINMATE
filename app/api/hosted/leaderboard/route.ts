import { NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** GET /api/hosted/leaderboard — real players ranked by ELO rating. */
export async function GET() {
  try {
    const players = await getLeaderboard();
    return NextResponse.json({ players });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load leaderboard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
