import { NextRequest, NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/config";
import { searchPlayersByUsername } from "@/lib/supabase/db";

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
    return NextResponse.json({ playersSearch: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
