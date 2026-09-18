import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  banPlayer,
  isAdminPlayer,
  passcodeSessionValid,
  unbanPlayer,
  usernameForPlayer,
  getBan,
} from "@/lib/server/admin";
import { totalRegisteredUsers } from "@/lib/server/messages";
import {
  deleteAccountByPlayerId,
  listRegisteredPlayerIds,
  playerProfileByUsername,
} from "@/lib/supabase/db";
import { getPlayerStats } from "@/lib/server/hosted";

export const runtime = "nodejs";

/**
 * Admin account management. The GET is the oversight list; POST carries the
 * penal actions including PERMANENT account deletion. Every mutation requires
 * BOTH the server-side admin identity AND a live dashboard passcode session
 * (the 4-digit code, 30-minute idle lock) — a stolen session token alone
 * opens nothing here.
 */

interface AccountsBody {
  playerId?: string;
  passcodeToken?: string;
  action?: "ban" | "unban" | "delete-account";
  targetPlayerId?: string;
  reason?: string;
}

async function guard(req: NextRequest, claimed: string, passcodeToken: string | null) {
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) return acting;
  if (!(await isAdminPlayer(acting.playerId))) {
    return { ok: false as const, error: "Not found", status: 404 };
  }
  if (!passcodeSessionValid(passcodeToken)) {
    return { ok: false as const, error: "Dashboard locked: enter the passcode again", status: 423 };
  }
  return { ok: true as const, playerId: acting.playerId };
}

/** GET /api/admin/accounts?playerId=…&token=… — list + headline count. */
export async function GET(req: NextRequest) {
  const guardRes = await guard(
    req,
    req.nextUrl.searchParams.get("playerId") ?? "",
    req.nextUrl.searchParams.get("token"),
  );
  if (!guardRes.ok) {
    return NextResponse.json({ error: guardRes.error }, { status: guardRes.status });
  }
  try {
    const ids = await listRegisteredPlayerIds();
    const accounts = [];
    for (const id of ids.slice(0, 200)) {
      const [name, stats, ban] = await Promise.all([
        usernameForPlayer(id),
        getPlayerStats(id).catch(() => null),
        getBan(id),
      ]);
      accounts.push({
        playerId: id,
        username: name,
        rating: stats?.rating ?? null,
        games: stats?.games ?? 0,
        banned: Boolean(ban),
        banReason: ban?.reason ?? null,
      });
    }
    accounts.sort((a, b) => (a.username ?? "").localeCompare(b.username ?? ""));
    const totalUsers = await totalRegisteredUsers();
    // The headline count must never read lower than the list we just served:
    // the list is a page-capped slice, the count is the authoritative total.
    // If the count lookup fails while the list succeeds, the list length is
    // a far better answer than a confident zero.
    return NextResponse.json({
      accounts,
      totalUsers: Math.max(totalUsers, ids.length),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load accounts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST /api/admin/accounts { playerId, passcodeToken, action, targetPlayerId } */
export async function POST(req: NextRequest) {
  let body: AccountsBody;
  try {
    body = (await req.json()) as AccountsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const fromQuery = req.nextUrl.searchParams.get("playerId")?.trim() ?? "";
  const guardRes = await guard(req, claimed || fromQuery, body.passcodeToken ?? null);
  if (!guardRes.ok) {
    return NextResponse.json({ error: guardRes.error }, { status: guardRes.status });
  }

  // Accept a username or a player id for the target.
  const raw = (body.targetPlayerId ?? "").trim();
  if (!raw) {
    return NextResponse.json({ error: "targetPlayerId is required" }, { status: 400 });
  }
  let target = raw;
  if (!/^(acct|guest)_/i.test(raw)) {
    const profile = await playerProfileByUsername(raw);
    if (!profile) {
      return NextResponse.json({ error: `No account found for "${raw}"` }, { status: 404 });
    }
    target = profile.player_id;
  }
  if (target === guardRes.playerId && body.action === "delete-account") {
    return NextResponse.json({ error: "You cannot delete your own admin account" }, { status: 400 });
  }

  try {
    if (body.action === "ban") {
      const record = await banPlayer(target, body.reason ?? "", guardRes.playerId);
      return NextResponse.json({ ok: true, ban: record });
    }
    if (body.action === "unban") {
      const removed = await unbanPlayer(target);
      if (!removed) {
        return NextResponse.json({ error: "That player is not banned" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "delete-account") {
      // Deletion is permanent: the auth user row goes first, every owned row
      // cascades (0005), and a ban record is kept so a rejoining player with
      // the same name is still visible in the restrictions list.
      const name = await usernameForPlayer(target);
      const res = await deleteAccountByPlayerId(target);
      if (!res.ok) {
        return NextResponse.json({ error: res.error ?? "Delete failed" }, { status: 500 });
      }
      await banPlayer(target, `Account deleted by admin${name ? ` (${name})` : ""}`, guardRes.playerId);
      return NextResponse.json({ ok: true, deleted: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Action failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
