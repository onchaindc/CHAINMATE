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

      // Check availability, excluding this player's own row so re-saving the
      // same name (or a case change) isn't reported as taken. Excluding by
      // player_id is sufficient: storePlayerId is this profile's own
      // player_id whenever a row exists, and player_id is `not null`, so the
      // .neq() is NULL-safe. (usernameTaken's excludeUserId path needed an
      // explicit NULL guard for exactly that reason — see lib/supabase/db.ts.)
      const stats = await getPlayerStats(storePlayerId);
      if (stats.username?.toLowerCase() !== newUsername.toLowerCase()) {
        if (await usernameTaken(newUsername, undefined, storePlayerId)) {
          return NextResponse.json(
            { error: "That username is already taken." },
            { status: 409 },
          );
        }
      }

      // Update the Supabase profile FIRST, and treat it as authoritative.
      //
      // Filter by the same key the read path uses. GET /api/identity/status
      // resolves the account via profileForUserId() -> .eq("user_id", ...), so
      // writing by player_id here meant a rename could update zero rows while
      // still reporting success — the client then re-read by user_id, got the
      // old value, and fell back to "Player". Guests have no user_id, so they
      // continue to key off player_id.
      if (supabaseConfigured()) {
        const admin = getSupabaseAdmin();
        const filterColumn = auth?.userId ? "user_id" : "player_id";
        const filterValue = auth?.userId ?? storePlayerId;

        // Supabase reports failures on the result object rather than throwing,
        // and a filter matching nothing is not an error at all — so both have
        // to be checked explicitly. .select() is what makes the row count
        // observable.
        const { data: updated, error: updateError } = await admin!
          .from("profiles")
          .update({ username: newUsername, updated_at: new Date().toISOString() })
          .eq(filterColumn, filterValue)
          .select("user_id, player_id, username");

        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 });
        }
        if (!updated || updated.length === 0) {
          return NextResponse.json(
            {
              error:
                "No profile is linked to this account yet, so the name could not be saved. Sign out and back in to finish account setup.",
            },
            { status: 409 },
          );
        }
      }

      // Mirror into the game store only after the durable write succeeded.
      // updatePlayerIdentity() materialises a record for any id it is handed,
      // so calling it first would fabricate a stats row under a mismatched id.
      await updatePlayerIdentity(storePlayerId, { username: newUsername });
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
 *  - player_achievements and friendships rows for this player_id
 *  - Supabase auth user, which cascades to the profiles row
 *  - Game store record (tombstoned)
 *
 * public.games is intentionally left intact: a game is a shared record and
 * removing it would destroy the opponent's history too. See
 * supabase/migrations/0005_cascade_player_data.sql.
 */
export async function DELETE(req: NextRequest) {
  const auth = await resolveAuthUser(req);
  if (!auth) {
    return NextResponse.json({ error: "You must be signed in to delete your account." }, { status: 401 });
  }

  const playerId = auth.profile?.player_id;

  try {
    // 1. Delete the player-scoped child rows explicitly.
    //
    // Migration 0005 adds ON DELETE CASCADE foreign keys for these, but do
    // not rely on that here: the constraints only exist once an operator has
    // run 0005, and this route previously *claimed* the cascade while the
    // schema had exactly one FK in it (profiles.user_id → auth.users), so
    // achievements and friendships survived every account deletion and
    // deleted users kept showing up in other players' friends lists.
    // Deleting explicitly is correct both before and after the migration.
    if (supabaseConfigured() && playerId) {
      const admin = getSupabaseAdmin();

      const { error: achError } = await admin!
        .from("player_achievements")
        .delete()
        .eq("player_id", playerId);
      if (achError) {
        return NextResponse.json({ error: achError.message }, { status: 500 });
      }

      // Friendships reference the player from either side of the pair. Two
      // .eq() deletes rather than one .or(): .or() takes a raw PostgREST
      // filter string that the value is interpolated into, and player_id is a
      // free-form text column. Binding each side separately avoids that
      // entirely.
      for (const column of ["requester_player_id", "addressee_player_id"]) {
        const { error: friendError } = await admin!
          .from("friendships")
          .delete()
          .eq(column, playerId);
        if (friendError) {
          return NextResponse.json({ error: friendError.message }, { status: 500 });
        }
      }
    }

    // 2. Delete the Supabase auth user. The profiles row goes with it via the
    //    FK cascade declared in 0001.
    //
    //    deleteUser reports failure on the result object rather than throwing,
    //    so the surrounding try/catch cannot see it. Unchecked, a failed
    //    deletion returned { ok: true } and the account stayed live while the
    //    UI reported success.
    if (supabaseConfigured()) {
      const admin = getSupabaseAdmin();
      const { error: deleteError } = await admin!.auth.admin.deleteUser(auth.userId);
      if (deleteError) {
        return NextResponse.json({ error: deleteError.message }, { status: 500 });
      }
    }

    // 3. Tombstone the game store record. Last, because it is the only step
    //    that cannot be rolled back by a later failure.
    if (playerId) {
      try {
        await updatePlayerIdentity(playerId, {
          username: `Deleted_${playerId.slice(-4)}`,
          isGuest: true,
        });
      } catch {
        // The game store may never have seen this player. The account itself
        // is already gone, so this is not worth failing the request over.
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete account";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
