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
    const schema = await supabaseSchemaReady().catch(() => ({
      ok: false as const,
      error: "Could not reach Supabase",
    }));
    return NextResponse.json({
      configured: true,
      authenticated: false,
      schemaReady: schema.ok,
      schemaError: schema.error ?? null,
    });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin!.auth.getUser(token);
  if (error || !data.user) {
    return NextResponse.json(
      { configured: true, authenticated: false, error: "Session expired. Please sign in again." },
      { status: 401 },
    );
  }

  /* Self-heal: the old stats-mirror bug flipped real account rows to
     is_guest = true (fixed in code, but flipped rows stayed flipped and the
     admin registered count read 0 forever after). A row bound to an auth
     user is by definition a registered account, so any authenticated player
     with a guest-flagged row gets it corrected here, once, on sign-in. The
     durable bulk heal is migration 0014. */
  try {
    await admin!
      .from("profiles")
      .update({ is_guest: false })
      .eq("user_id", data.user.id)
      .eq("is_guest", true);
  } catch {
    // Non-fatal: the read below reflects the healed state on the next load.
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

  /* Self-heal: a profile row whose picture vanished while the upload itself
     still exists in storage (a profile-row rebuild during the guest →
     account upgrade, a failed update, or any path that wrote avatar_url
     back to null). The object is the source of truth — if `<player_id>.webp`
     is in the bucket and the row points nowhere, re-point it at the same
     public URL. One cheap existence check per sign-in, only when the row is
     actually missing the URL. */
  if (!profile.avatar_url) {
    try {
      const path = `${profile.player_id}.webp`;
      const { data: objs } = await admin!.storage.from("avatars").list("", {
        search: path,
      });
      if (objs && objs.some((o) => o.name === path)) {
        const { data: pub } = admin!.storage.from("avatars").getPublicUrl(path);
        const restored = `${pub.publicUrl}?v=${Date.now()}`;
        const { error: healError } = await admin!
          .from("profiles")
          .update({ avatar_url: restored })
          .eq("player_id", profile.player_id);
        if (!healError) {
          profile.avatar_url = restored;
        }
      }
    } catch {
      // Storage hiccup: serve the row as-is rather than failing sign-in.
    }
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
    avatarUrl: profile.avatar_url ?? null,
  });
}
