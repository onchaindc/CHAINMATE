import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import { profileForUserId, supabaseSchemaReady } from "@/lib/supabase/db";

export const runtime = "nodejs";

/**
 * GET /api/identity/status
 * Authorization: Bearer <access_token>
 *
 * Resolves the stored session to the ChainMate account (username, the
 * account's permanent player id, current rating). Guests simply don't send
 * a token — they're identified by their device player id in the game store.
 */
export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ configured: false, authenticated: false });
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    const schemaReady = await supabaseSchemaReady().catch(() => false);
    return NextResponse.json({ configured: true, authenticated: false, schemaReady });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin!.auth.getUser(token);
  if (error || !data.user) {
    return NextResponse.json(
      { configured: true, authenticated: false, error: "Session expired. Please sign in again." },
      { status: 401 },
    );
  }

  const profile = await profileForUserId(data.user.id);
  if (!profile) {
    // Authenticated but never linked (e.g. the OTP was verified and the
    // guest → account upgrade hasn't finished yet). The app keeps playing
    // under the device guest id until the profile exists.
    return NextResponse.json({
      configured: true,
      authenticated: true,
      linked: false,
      userId: data.user.id,
      username: null,
      playerId: null,
    });
  }

  return NextResponse.json({
    configured: true,
    authenticated: true,
    linked: true,
    userId: data.user.id,
    username: profile.username,
    playerId: profile.player_id,
    rating: profile.rating,
    games: profile.games,
    isGuest: false,
  });
}
