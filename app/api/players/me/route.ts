import { NextRequest, NextResponse } from "next/server";
import { updatePlayerCountry } from "@/lib/server/hosted";

export const runtime = "nodejs";

/** POST /api/players/me { playerId, country } — set/clear the optional flag. */
export async function POST(req: NextRequest) {
  let body: { playerId?: string; country?: string | null };
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
    const stats = await updatePlayerCountry(
      playerId,
      typeof body.country === "string" ? body.country : null,
    );
    return NextResponse.json({ stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
