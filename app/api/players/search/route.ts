import { NextRequest, NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/config";
import { friendshipStatus, searchPlayersByUsername } from "@/lib/supabase/db";

export const runtime = "nodejs";

/** GET /api/players/search?q=term — find ChainMate accounts by username. */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ playersSearch: [] });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Accounts aren't configured on this deployment yet." },
      { status: 503 },
    );
  }
  try {
    const rows = await searchPlayersByUsername(q);
    // Annotate each row with the VIEWER's friendship state so the Add button
    // can honestly say "Sent" / "Friends" instead of pretending nothing
    // happened after a request goes out.
    const viewer = req.nextUrl.searchParams.get("viewer") ?? "";
    let annotated = rows;
    if (viewer && rows.length > 0) {
      annotated = await Promise.all(
        rows.map(async (r) => ({
          ...r,
          friendship: r.player_id === viewer ? "self" : await friendshipStatus(viewer, r.player_id),
        })),
      );
    }
    return NextResponse.json({ playersSearch: annotated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
