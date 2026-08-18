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
  /** OAuth (Google) sign-in. When true and no existing profile, returns needsOnboarding.
   *  When true AND username is provided, creates the profile with that username (onboarding step 2). */
  google?: boolean;
}



/**
 * POST /api/identity/link  { username }
 * Authorization: Bearer <access_token>
 *
 * Creates the account profile after the email code is verified. Accounts
 * ALWAYS start fresh: the profile gets a brand-new player id with the
 * default provisional rating (1200 / rd 350). Guest games are casual and
 * never rated, so there is no guest history to carry over — the guest's
 * device id stays on this device and is never merged.
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

  const google = body.google === true;
  const username = (body.username ?? "").trim();
  // Always validate the username when provided (including Google onboarding step 2).
  if (username) {
    const nameError = validateUsername(username);
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 });
    }
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
      // Google returning user: return the existing profile. Never rename.
      if (google) {
        return NextResponse.json({ profile: existing, playerId: existing.player_id });
      }
      // Account already linked — just sync the identity (e.g. sign-in on a
      // new device). Never overwrite the account's rating or history.
      if (username && existing.username !== username) {
        if (await usernameTaken(username, userId)) {
          return NextResponse.json(
            { error: "That username is already taken." },
            { status: 409 },
          );
        }
        await admin!.from("profiles").update({ username }).eq("user_id", userId);
      }
      return NextResponse.json({ profile: { ...existing, username: username || existing.username } });
    }

    // Google NEW user: if no username provided yet, trigger onboarding.
    if (google && !username) {
      return NextResponse.json({ needsOnboarding: true, userId });
    }

    // Google onboarding step 2: username provided — create the profile.
    if (google && username) {
      if (await usernameTaken(username, userId)) {
        return NextResponse.json(
          { error: "That username is already taken. Try another." },
          { status: 409 },
        );
      }
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

    // Email sign-in: username is required.
    if (!username) {
      return NextResponse.json({ error: "Username is required." }, { status: 400 });
    }
    if (await usernameTaken(username)) {
      return NextResponse.json(
        { error: "That username is already taken. Try another." },
        { status: 409 },
      );
    }

    // Always start fresh: a brand-new identity with the default provisional
    // rating (fresh stats, no guest games attached). The guest's old id stays
    // on this device; nothing is merged or reset on the account side.
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
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "We couldn't save your profile. Please try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
