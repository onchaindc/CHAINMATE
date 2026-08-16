import { NextRequest, NextResponse } from "next/server";
import { supabaseConfigured } from "@/lib/supabase/config";
import { usernameTaken } from "@/lib/supabase/db";
import { validateUsername } from "@/lib/achievements";

export const runtime = "nodejs";

/** GET /api/identity/username?value=… — availability + validity check. */
export async function GET(req: NextRequest) {
  const value = req.nextUrl.searchParams.get("value") ?? "";
  const validation = validateUsername(value);
  if (validation) {
    return NextResponse.json({ available: false, reason: validation });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json({ configured: false });
  }
  try {
    const taken = await usernameTaken(value);
    return NextResponse.json({
      available: !taken,
      reason: taken ? "That username is already taken." : null,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message.includes("fetch failed")
        ? "Can't reach the accounts service right now."
        : err instanceof Error
          ? err.message
          : "Could not check that username.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
