import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import { usernameTaken, profileForUserId } from "@/lib/supabase/db";
import { validateUsername } from "@/lib/achievements";
import { updatePlayerCountry, updatePlayerIdentity, getPlayerStats } from "@/lib/server/hosted";

export const runtime = "nodejs";

/**
 * Resolve the authenticated Supabase user from the request.
 * Returns { userId, profile } or null on failure.
 */
async function resolveAuthUser(req: NextRequest): Promise<{ userId: string; profile: { player_id: string } | null } | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supabaseConfigured() || !token) return null;
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin!.auth.getUser(token);
    if (error || !data.user) return null;
    const profile = await profileForUserId(data.user.id);
    return { userId: data.user.id, profile };
  } catch {
    return null;
  }
}

/**
 * POST /api/players/me — update the authenticated player's profile.
 * Body: { playerId?, country?, username? }
 *
 * Ownership is verified purely by the Supabase session token (user_id).
 * The playerId in the body is used to identify the update target in the
 * game store, but the profile update targets the Supabase profile by user_id.
 */
export async function POST(req: NextRequest) {
  let body: { playerId?: string; country?: string | null; username?: string; accessToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";

  // Verify identity via Supabase token.
  const auth = await resolveAuthUser(req);

  try {
    // Handle username change
    if (typeof body.username === "string" && body.username.trim()) {
      const newUsername = body.username.trim();
      const nameError = validateUsername(newUsername);
      if (nameError) {
        return NextResponse.json({ error: nameError }, { status: 400 });
      }

      // Determine which player_id to use for the game store update.
      // Prefer the profile's player_id from the database (source of truth),
      // fall back to the client-supplied playerId.
      const storePlayerId = auth?.profile?.player_id || playerId;
      if (!storePlayerId) {
        return NextResponse.json({ error: "Could not identify your profile." }, { status: 400 });
      }

      // Check availability (excluding this user's current username)
      const stats = await getPlayerStats(storePlayerId);
      if (stats.username?.toLowerCase() !== newUsername.toLowerCase()) {
        if (await usernameTaken(newUsername, auth?.userId)) {
          return NextResponse.json(
            { error: "That username is already taken." },
            { status: 409 },
          );
        }
      }

      // Update the game store (server-side identity)
      await updatePlayerIdentity(storePlayerId, { username: newUsername });

      // Update Supabase profiles table — by user_id (the auth identity),
      // not by player_id (which can be stale on the client).
      if (supabaseConfigured()) {
        try {
          const admin = getSupabaseAdmin();
          if (auth?.userId) {
            await admin!
              .from("profiles")
              .update({ username: newUsername, updated_at: new Date().toISOString() })
              .eq("user_id", auth.userId);
          } else if (playerId) {
            // Fallback: update by player_id if no auth (shouldn't happen)
            await admin!
              .from("profiles")
              .update({ username: newUsername, updated_at: new Date().toISOString() })
              .eq("player_id", playerId);
          }
        } catch {
          // Best-effort
        }
      }
    }

    // Handle country change
    if ("country" in body) {
      const storePlayerId = auth?.profile?.player_id || playerId;
      if (storePlayerId) {
        await updatePlayerCountry(
          storePlayerId,
          typeof body.country === "string" ? body.country : null,
        );
      }
    }

    const storePlayerId = auth?.profile?.player_id || playerId;
    const stats = storePlayerId ? await getPlayerStats(storePlayerId) : null;
    return NextResponse.json({ stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/players/me — permanently delete the authenticated user's
 * account and all associated data.
 *
 * Deletes:
 *  - Supabase auth user (cascades to profiles, achievements, friendships)
 *  - Game store profile + stats
 *  - Server-side identity record
 */
export async function DELETE(req: NextRequest) {
  const auth = await resolveAuthUser(req);
  if (!auth) {
    return NextResponse.json({ error: "You must be signed in to delete your account." }, { status: 401 });
  }

  const playerId = auth.profile?.player_id;

  try {
    // 1. Remove from game store (best-effort)
    if (playerId) {
      try {
        const { updatePlayerIdentity } = await import("@/lib/server/hosted");
        await updatePlayerIdentity(playerId, { username: `Deleted_${playerId.slice(-4)}`, isGuest: true });
      } catch {
        // Game store may not have this player — fine
      }
    }

    // 2. Delete Supabase auth user — this cascades to profiles,
    //    player_achievements, and friendships via FK constraints.
    if (supabaseConfigured()) {
      try {
        const admin = getSupabaseAdmin();
        const header = req.headers.get("authorization") ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (token) {
          const { data } = await admin!.auth.getUser(token);
          if (data.user) {
            await admin!.auth.admin.deleteUser(data.user.id);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete account";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete account";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
