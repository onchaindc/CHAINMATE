import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  banPlayer,
  isAdminPlayer,
  listBans,
  unbanPlayer,
  usernameForPlayer,
} from "@/lib/server/admin";

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

/** POST /api/admin/bans { playerId, action: "ban" | "unban", reason } */
export async function POST(req: NextRequest) {
  let body: BanBody;
  try {
    body = (await req.json()) as BanBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const isAdmin = await isAdminPlayer(acting.playerId);
  if (!isAdmin) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const target = (body.targetPlayerId ?? "").trim();
  if (!target) {
    return NextResponse.json({ error: "targetPlayerId is required" }, { status: 400 });
  }

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
