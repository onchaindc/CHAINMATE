import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  adminSessionToken,
  banPlayer,
  isAdminPlayer,
  listBans,
  passcodeSessionValid,
  unbanPlayer,
  usernameForPlayer,
} from "@/lib/server/admin";
import { playerProfileByUsername } from "@/lib/supabase/db";

export const runtime = "nodejs";

/**
 * Admin bans — the operator's penal tool. The route is invisible to anyone
 * else (an admin check fails closed with a plain 404 so the endpoint's
 * existence is not even advertised), and every mutation re-checks the
 * caller's identity through the standard resolveActingPlayer path.
 */

interface BanBody {
  /** The acting admin's claimed playerId (verified against the session). */
  playerId?: string;
  /** The player the action targets. */
  targetPlayerId?: string;
  action?: "ban" | "unban";
  /** Admin-set reason, stored with the ban and shown to the player. */
  reason?: string;
}

async function adminGuard(req: NextRequest, claimed: string) {
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) return acting;
  const isAdmin = await isAdminPlayer(acting.playerId);
  if (!isAdmin) {
    return { ok: false as const, error: "Not found", status: 404 };
  }
  // GETs carry the passcode session too (X-Admin-Session header / ?token=):
  // a locked dashboard must show the lock screen, not an empty list.
  if (!(await passcodeSessionValid(adminSessionToken(req)))) {
    return { ok: false as const, error: "Dashboard locked: enter the passcode again", status: 423 };
  }
  return { ok: true as const, playerId: acting.playerId };
}

/** GET /api/admin/bans?playerId=… — every active ban, newest first. */
export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const guard = await adminGuard(req, claimed);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const bans = await listBans();
    const names: Record<string, string> = {};
    for (const b of bans) {
      const name = await usernameForPlayer(b.playerId);
      if (name) names[b.playerId] = name;
    }
    return NextResponse.json({ bans, names });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load bans";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Resolve the operator's identity from the body OR the query string. The
 * dashboard sends it in the URL (like every GET here); the POST body is the
 * other legitimate channel — accept both, require neither to be duplicated.
 */
function claimedPlayerId(req: NextRequest, body: BanBody): string {
  const fromBody = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (fromBody) return fromBody;
  return req.nextUrl.searchParams.get("playerId")?.trim() ?? "";
}

/**
 * Accept a playerId (acct_… / guest_…) or a username. Bans are stored by
 * playerId, so a username is resolved through the profile table — the
 * operator types names, not internal ids.
 */
async function resolveTarget(raw: string): Promise<{ ok: true; playerId: string } | { ok: false; error: string }> {
  const target = raw.trim();
  if (!target) return { ok: false, error: "targetPlayerId is required" };
  if (/^(acct|guest)_/i.test(target)) return { ok: true, playerId: target };
  const profile = await playerProfileByUsername(target);
  if (!profile) {
    return { ok: false, error: `No account found with the username "${target}".` };
  }
  return { ok: true, playerId: profile.player_id };
}

/** POST /api/admin/bans { playerId, action: "ban" | "unban", reason } */
export async function POST(req: NextRequest) {
  let body: BanBody;
  try {
    body = (await req.json()) as BanBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const acting = await resolveActingPlayer(req, claimedPlayerId(req, body));
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const isAdmin = await isAdminPlayer(acting.playerId);
  if (!isAdmin) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const resolved = await resolveTarget(body.targetPlayerId ?? "");
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const target = resolved.playerId;

  try {
    if (body.action === "ban") {
      // Never lock an admin out of the dashboard by their own action.
      if (target === acting.playerId) {
        return NextResponse.json({ error: "You cannot ban yourself" }, { status: 400 });
      }
      const record = await banPlayer(target, body.reason ?? "", acting.playerId);
      return NextResponse.json({ ban: record });
    }
    if (body.action === "unban") {
      const removed = await unbanPlayer(target);
      if (!removed) {
        return NextResponse.json({ error: "That player is not banned" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update bans";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
