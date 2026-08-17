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
import { randomHex } from "@/lib/utils";

export const runtime = "nodejs";

interface LinkBody {
  username?: string;
  playerId?: string;
  /**
   * Guest → account upgrade mode. true (default): the guest's real stats,
   * games and achievements carry into the permanent profile under the SAME
   * player id. false: the account starts clean with a fresh identity and the
   * default provisional rating — the guest's device history is left behind.
   */
  keepHistory?: boolean;
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
  let authUser;
  try {
    const result = await admin!.auth.getUser(token);
    if (result.error || !result.data.user) {
      const detail = result.error?.message ?? "";
      const networkIssue =
        detail.includes("fetch") || detail.includes("network") || detail.includes("ENOTFOUND");
      return NextResponse.json(
        networkIssue
          ? {
              error:
                "Could not reach the accounts service right now. Please try again in a moment.",
            }
          : { error: "Your session has expired. Please sign in again." },
        { status: networkIssue ? 503 : 401 },
      );
    }
    authUser = result.data.user;
  } catch {
    return NextResponse.json(
      { error: "Could not reach the accounts service right now. Please try again in a moment." },
      { status: 503 },
    );
  }
  const userId = authUser.id;

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

    const keepHistory = body.keepHistory !== false;
    if (!keepHistory) {
      // "Start fresh": the account gets a brand-new identity with the
      // default provisional rating (fresh stats, no guest games attached).
      // The guest's old id stays on this device; nothing is merged or reset
      // on the account side.
      const freshPlayerId = `acct_${randomHex(8)}`;
      const stats = await getPlayerStats(freshPlayerId); // defaults: 1200 / rd 350
      const profile = await linkProfileToAccount({
        userId,
        playerId: freshPlayerId,
        username,
        stats,
      });
      await updatePlayerIdentity(freshPlayerId, { username, isGuest: false });
      return NextResponse.json({ profile, playerId: freshPlayerId });
    }

    // "Keep history": carry the guest's real stats into the permanent profile
    // under the same player id — one identity, nothing duplicated or reset.
    const stats = await getPlayerStats(playerId);
    const profile = await linkProfileToAccount({
      userId,
      playerId,
      username,
      stats,
    });

    // The game store now knows this player by their chosen name.
    await updatePlayerIdentity(playerId, { username, isGuest: false });

    return NextResponse.json({ profile, playerId });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "We couldn't save your profile. Please try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
