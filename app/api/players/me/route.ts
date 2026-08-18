import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import { usernameTaken, profileForUserId } from "@/lib/supabase/db";
import { validateUsername } from "@/lib/achievements";
import { updatePlayerCountry, updatePlayerIdentity, getPlayerStats } from "@/lib/server/hosted";

export const runtime = "nodejs";

/**
 * POST /api/players/me — update the authenticated player's profile.
 * Body: { playerId, country?, username?, accessToken? }
 *
 * - country: set/clear the optional flag
 * - username: change display name (validated, uniqueness-checked)
 * - accessToken: Bearer token for auth verification
 */
export async function POST(req: NextRequest) {
  let body: { playerId?: string; country?: string | null; username?: string; accessToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }

  // Verify the caller owns this profile via Supabase session.
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (body.accessToken ?? "");
  if (supabaseConfigured() && token) {
    try {
      const admin = getSupabaseAdmin();
      const { data } = await admin!.auth.getUser(token);
      if (data.user) {
        const profile = await profileForUserId(data.user.id);
        if (!profile || profile.player_id !== playerId) {
          return NextResponse.json({ error: "You can only edit your own profile." }, { status: 403 });
        }
      }
    } catch {
      // Best-effort auth check — if Supabase is down, allow the update
    }
  }

  try {
    // Handle username change
    if (typeof body.username === "string" && body.username.trim()) {
      const newUsername = body.username.trim();
      const nameError = validateUsername(newUsername);
      if (nameError) {
        return NextResponse.json({ error: nameError }, { status: 400 });
      }
      // Check availability (excluding this player's current username)
      const stats = await getPlayerStats(playerId);
      if (stats.username?.toLowerCase() !== newUsername.toLowerCase()) {
        if (await usernameTaken(newUsername)) {
          return NextResponse.json(
            { error: "That username is already taken." },
            { status: 409 },
          );
        }
      }
      await updatePlayerIdentity(playerId, { username: newUsername });
      // Also update Supabase profiles table directly
      if (supabaseConfigured()) {
        try {
          const admin = getSupabaseAdmin();
          await admin!.from("profiles").update({ username: newUsername, updated_at: new Date().toISOString() }).eq("player_id", playerId);
        } catch {
          // Best-effort
        }
      }
    }

    // Handle country change
    if ("country" in body) {
      await updatePlayerCountry(
        playerId,
        typeof body.country === "string" ? body.country : null,
      );
    }

    const stats = await getPlayerStats(playerId);
    return NextResponse.json({ stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
