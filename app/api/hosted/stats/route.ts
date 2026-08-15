import { NextResponse } from "next/server";
import { getPlatformStats } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** GET /api/hosted/stats — real platform counts (games, this week, players). */
export async function GET() {
  try {
    const stats = await getPlatformStats();
    return NextResponse.json({ stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load stats";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
