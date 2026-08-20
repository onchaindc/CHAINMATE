import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import { profileForPlayerId, profileForUserId } from "@/lib/supabase/db";

/**
 * Who a request is allowed to act as.
 *
 * Game writes used to trust the `playerId` in the request body outright, so
 * anyone who knew a game id and a participant's player id could resign, move,
 * or abort on their behalf. The identity now comes from the Supabase session
 * token whenever one is present, and a request without a token may only act as
 * a player that no account owns.
 *
 * Guests stay usable: their player id is device-local and has no profile row,
 * so an unauthenticated request still passes for them. What it can no longer do
 * is impersonate a signed-in account.
 */

/** The player id behind a valid bearer token, or null when there isn't one. */
export async function tokenPlayerId(req: NextRequest): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supabaseConfigured() || !token) return null;
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin!.auth.getUser(token);
    if (error || !data.user) return null;
    const profile = await profileForUserId(data.user.id);
    return profile?.player_id ?? null;
  } catch {
    // A network hiccup talking to Supabase must not be readable as "authorised".
    return null;
  }
}

export type ActingPlayer =
  | { ok: true; playerId: string }
  | { ok: false; error: string; status: number };

/**
 * Resolve the player id a request may act as, given the one it claimed.
 *
 * A valid token wins outright — the caller's own claim is ignored rather than
 * merely checked, so a signed-in player can never be talked into acting as
 * someone else. Without a token, the claim is honoured only when it belongs to
 * a guest.
 */
export async function resolveActingPlayer(
  req: NextRequest,
  claimed: string,
): Promise<ActingPlayer> {
  if (!claimed) {
    return {
      ok: false,
      error: "playerId is required — send your browser's player identity",
      status: 400,
    };
  }

  const authed = await tokenPlayerId(req);
  if (authed) return { ok: true, playerId: authed };

  // No session. The claim is only acceptable if no account owns that identity.
  const owner = await profileForPlayerId(claimed);
  if (owner && owner.is_guest === false) {
    return {
      ok: false,
      error: "Sign in to play as this account.",
      status: 401,
    };
  }
  return { ok: true, playerId: claimed };
}
