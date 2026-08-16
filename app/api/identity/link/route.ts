import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import {
  linkProfileToAccount,
  profileForUserId,
  supabaseSchemaReady,
  usernameTaken,
} from "@/lib/supabase/db";
import { validateUsername } from "@/lib/achievements";
import { getPlayerStats, updatePlayerIdentity } from "@/lib/server/hosted";

export const runtime = "nodejs";

interface LinkBody {
  username?: string;
  playerId?: string;
}

/**
 * POST /api/identity/link  { username, playerId }
 * Authorization: Bearer <access_token>
 *
 * The guest → account upgrade. The anonymous player's real stats (ELO,
 * W/L/D, streaks, peak, achievements, games — all keyed by playerId in the
 * game store) are attached to the new Supabase profile. Nothing is reset,
 * duplicated or re-rolled: the same player id keeps playing, and the account
 * becomes the permanent record of that identity.
 */
export async function POST(req: NextRequest) {
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Account creation isn't configured yet. You can keep playing as a guest." },
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  const { data: auth, error: authError } = await admin!.auth.getUser(token);
  if (authError || !auth.user) {
    return NextResponse.json(
      { error: "Your session has expired. Please sign in again." },
      { status: 401 },
    );
  }
  const userId = auth.user.id;

  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const username = (body.username ?? "").trim();
  const nameError = validateUsername(username);
  if (nameError) {
    return NextResponse.json({ error: nameError }, { status: 400 });
  }

  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) {
    return NextResponse.json(
      { error: "Your player identity is missing. Refresh and try again." },
      { status: 400 },
    );
  }

  if (!(await supabaseSchemaReady())) {
    return NextResponse.json(
      {
        error:
          "The ChainMate database isn't initialized yet. Run supabase/migrations/0001_init.sql in your Supabase SQL editor, then try again.",
      },
      { status: 503 },
    );
  }

  try {
    const existing = await profileForUserId(userId);
    if (existing) {
      // Account already linked — just sync the identity (e.g. sign-in on a
      // new device). Never overwrite the account's rating or history.
      if (existing.username !== username) {
        if (await usernameTaken(username, userId)) {
          return NextResponse.json(
            { error: "That username is already taken." },
            { status: 409 },
          );
        }
        await admin!.from("profiles").update({ username }).eq("user_id", userId);
      }
      return NextResponse.json({ profile: { ...existing, username } });
    }

    if (await usernameTaken(username)) {
      return NextResponse.json(
        { error: "That username is already taken. Try another." },
        { status: 409 },
      );
    }

    // The upgrade: carry the guest's real stats into the permanent profile.
    const stats = await getPlayerStats(playerId);
    const profile = await linkProfileToAccount({
      userId,
      playerId,
      username,
      stats,
    });

    // The game store now knows this player by their chosen name.
    await updatePlayerIdentity(playerId, { username, isGuest: false });

    return NextResponse.json({ profile });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "We couldn't save your profile. Please try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
