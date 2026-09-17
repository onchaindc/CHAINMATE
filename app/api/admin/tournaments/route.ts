import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { isAdminPlayer } from "@/lib/server/admin";
import {
  adminCancelTournament,
  adminCompleteTournament,
  adminDeleteTournament,
  listAllTournamentsForAdmin,
} from "@/lib/server/admin-tournaments";

export const runtime = "nodejs";

/**
 * Admin tournament oversight. GET: every tournament with host, entries and
 * money detail. POST: force-cancel / force-complete / force-delete for the
 * stuck-event cases the host path cannot resolve. Both fail closed through
 * the same identity + admin checks as the bans route; anyone else gets a
 * plain 404 so the endpoint is not even advertised.
 */

interface AdminTournamentBody {
  playerId?: string;
  tournamentId?: string;
  action?: "cancel" | "complete" | "delete";
}

async function actingAdmin(req: NextRequest, claimed: string) {
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) return acting;
  const isAdmin = await isAdminPlayer(acting.playerId);
  if (!isAdmin) {
    return { ok: false as const, error: "Not found", status: 404 };
  }
  return { ok: true as const, playerId: acting.playerId };
}

/** GET /api/admin/tournaments?playerId=… — the oversight table. */
export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const guard = await actingAdmin(req, claimed);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const rows = await listAllTournamentsForAdmin();
    return NextResponse.json({ tournaments: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load tournaments";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST /api/admin/tournaments { playerId, tournamentId, action } */
export async function POST(req: NextRequest) {
  let body: AdminTournamentBody;
  try {
    body = (await req.json()) as AdminTournamentBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const fromQuery = req.nextUrl.searchParams.get("playerId")?.trim() ?? "";
  const guard = await actingAdmin(req, claimed || fromQuery);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const tournamentId = (body.tournamentId ?? "").trim();
  if (!tournamentId) {
    return NextResponse.json({ error: "tournamentId is required" }, { status: 400 });
  }
  if (body.action !== "cancel" && body.action !== "complete" && body.action !== "delete") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  try {
    const res =
      body.action === "cancel"
        ? await adminCancelTournament(guard.playerId, tournamentId)
        : body.action === "complete"
          ? await adminCompleteTournament(guard.playerId, tournamentId)
          : await adminDeleteTournament(guard.playerId, tournamentId);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true, message: res.message });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Action failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
