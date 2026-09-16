import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  deleteTournament,
  getTournamentDetail,
  joinTournament,
  leaveTournament,
  requestArenaPairing,
  transitionTournament,
} from "@/lib/server/tournaments";
import { requireAccountForPaidTournament } from "@/lib/server/tournament-economy";
import type { TournamentStatus } from "@/lib/tournament-types";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/tournaments/[id] — full detail: summary, entries, rounds/matches,
 * standings, and the viewer's relationship to the event. Public read —
 * spectator data, no credentials needed.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const viewer = req.nextUrl.searchParams.get("playerId") ?? undefined;
  try {
    const detail = await getTournamentDetail(id, viewer);
    if (!detail) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load tournament";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface ActionBody {
  action:
    | "join"
    | "leave"
    | "open-registration"
    | "lock"
    | "reopen-registration"
    | "start"
    | "complete"
    | "cancel"
    | "delete"
    | "pair";
  playerId?: string;
}
const STATUS_ACTIONS: Partial<Record<ActionBody["action"], TournamentStatus>> = {
  "open-registration": "registration",
  lock: "locked",
  "reopen-registration": "registration",
  start: "in_progress",
  complete: "completed",
  cancel: "cancelled",
};

/**
 * POST /api/tournaments/[id] — state-changing actions, all authenticated
 * through resolveActingPlayer. The client can never submit a result, a
 * winner, a rank or a standing — those are engine-computed only.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  try {
    switch (body.action) {
      case "join": {
        // H2: a PAID tournament can never be joined without an account.
        // Gate here too — the paid-entry route is the normal path, but the
        // plain join endpoint must also refuse guests on paid events.
        const { getTournamentDoc } = await import("@/lib/server/tournament-store");
        const doc = await getTournamentDoc(id);
        if (!doc) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
        try {
          await requireAccountForPaidTournament(doc, acting.playerId);
        } catch (gateErr) {
          const message = gateErr instanceof Error ? gateErr.message : "Account required";
          return NextResponse.json({ error: message }, { status: 403 });
        }
        const res = await joinTournament(id, acting.playerId);
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
        return NextResponse.json({ ok: true });
      }
      case "leave": {
        const res = await leaveTournament(id, acting.playerId);
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
        return NextResponse.json({ ok: true });
      }
      case "open-registration":
      case "lock":
      case "reopen-registration":
      case "start":
      case "complete":
      case "cancel": {
        const res = await transitionTournament(
          id,
          acting.playerId,
          STATUS_ACTIONS[body.action]!,
        );
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
        return NextResponse.json({ ok: true });
      }
      case "delete": {
        const res = await deleteTournament(id, acting.playerId);
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
        return NextResponse.json({ ok: true, deleted: true });
      }
      case "pair": {
        // Arena only: ask for a pairing while the event runs.
        const res = await requestArenaPairing(id, acting.playerId);
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 });
        return NextResponse.json({ ok: true, match: res.match });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
