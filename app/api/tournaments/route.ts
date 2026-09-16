import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  createTournament,
  listTournaments,
} from "@/lib/server/tournaments";
import { isTournamentFormat } from "@/lib/tournament-types";
import { parseEntryFeeNim } from "@/lib/tournament-economy";

export const runtime = "nodejs";

/**
 * GET /api/tournaments?status=registration — the tournament list.
 * Player names for the hosts come back in the same payload.
 */
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  try {
    const { tournaments, players } = await listTournaments({
      status:
        status === "draft" ||
        status === "registration" ||
        status === "locked" ||
        status === "in_progress" ||
        status === "completed" ||
        status === "cancelled"
          ? status
          : undefined,
      limit: 50,
    });
    return NextResponse.json({ tournaments, players });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list tournaments";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface CreateBody {
  playerId?: string;
  name?: string;
  description?: string;
  format?: string;
  timeControl?: string;
  maxPlayers?: number;
  swissRounds?: number;
  registrationClosesAt?: number | null;
  /** Scheduled start (Unix ms) — the event opens registration at this time. */
  scheduledStartAt?: number | null;
  /** Phase 2B: human NIM string ("5", "1.25") — parsed to exact luna server-side. */
  entryFeeNim?: string;
  /** Phase 2B: prize distribution preset (required when a fee is set). */
  prizePreset?: string;
}

/**
 * POST /api/tournaments — create a tournament (DRAFT). The creator becomes
 * the host. Validation is server-side; the client cannot choose a status.
 *
 * Phase 2A boundary: there is no entry fee, no prize pool, no payout field
 * in this request — free tournaments only.
 */
export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  if (!isTournamentFormat(body.format)) {
    return NextResponse.json(
      { error: "format must be knockout, swiss or arena" },
      { status: 400 },
    );
  }

  try {
    // Phase 2B: exact fee parsing happens HERE, server-side. The client's
    // string is converted to bigint luna and validated by the engine; a
    // paid tournament must also name a valid preset. Any client-supplied
    // prize-pool number would be ignored — the pool is always derived from
    // verified payments only.
    let entryFeeLuna: bigint | undefined;
    let prizePreset: "winner" | "top3" | "top5" | undefined;
    if (typeof body.entryFeeNim === "string" && body.entryFeeNim.trim() !== "") {
      try {
        entryFeeLuna = parseEntryFeeNim(body.entryFeeNim);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Invalid entry fee" },
          { status: 400 },
        );
      }
      if (entryFeeLuna > 0n) {
        if (body.prizePreset !== "winner" && body.prizePreset !== "top3" && body.prizePreset !== "top5") {
          return NextResponse.json(
            { error: "a paid tournament requires a prize distribution preset (winner, top3 or top5)" },
            { status: 400 },
          );
        }
        prizePreset = body.prizePreset;
      }
    }

    const doc = await createTournament(acting.playerId, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : undefined,
      format: body.format,
      timeControl: typeof body.timeControl === "string" ? body.timeControl : "",
      maxPlayers: typeof body.maxPlayers === "number" ? Math.floor(body.maxPlayers) : NaN,
      swissRounds:
        typeof body.swissRounds === "number" ? Math.floor(body.swissRounds) : undefined,
      registrationClosesAt:
        typeof body.registrationClosesAt === "number" ? body.registrationClosesAt : null,
      scheduledStartAt:
        typeof body.scheduledStartAt === "number" ? body.scheduledStartAt : null,
      entryFeeLuna,
      prizePreset,
    });
    return NextResponse.json({ tournament: { id: doc.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create tournament";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
