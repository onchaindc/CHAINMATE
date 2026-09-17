import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { isAdminPlayer } from "@/lib/server/admin";

export const runtime = "nodejs";

/**
 * GET /api/admin/whoami?playerId=… — is the caller a ChainMate admin?
 *
 * Powers the (hidden) dashboard link in the account menu: the page itself
 * also enforces the flag server-side, so lying to this endpoint buys a
 * 404, not access.
 */
export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  if (!claimed) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  return NextResponse.json({ admin: await isAdminPlayer(acting.playerId) });
}
