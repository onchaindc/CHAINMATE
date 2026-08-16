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
  const taken = await usernameTaken(value);
  return NextResponse.json({
    available: !taken,
    reason: taken ? "That username is already taken." : null,
  });
}
