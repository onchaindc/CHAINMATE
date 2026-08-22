import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  abortHostedGame,
  getHostedGame,
  joinHostedGame,
  offerDrawHostedGame,
  rematchHostedGame,
  resignHostedGame,
  respondHostedDraw,
  submitHostedMove,
  summarizeHostedGame,
} from "@/lib/server/hosted";

export const runtime = "nodejs";

/**
 * The "summary" action below deploys a contract and waits on GenLayer validator
 * consensus, which takes far longer than the default serverless limit — at the
 * default this handler would be killed mid-analysis every time. 60s is the
 * ceiling that is valid on every Vercel plan.
 *
 * Consensus can still outlast it. That is survivable rather than fatal: the
 * game keeps its deterministic fallback report, the analysis stays marked as
 * outstanding, and the client can ask again — see summarizeHostedGame.
 */
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** GET /api/hosted/games/[id] — read current game state. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const game = await getHostedGame(id);
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    return NextResponse.json({ game });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load game";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface ActionBody {
  action:
    | "join"
    | "move"
    | "resign"
    | "draw-offer"
    | "draw-respond"
    | "abort"
    | "rematch"
    | "timeout"
    | "summary";
  playerId?: string;
  move?: { from: string; to: string; promotion?: string };
  accept?: boolean;
}

/** POST /api/hosted/games/[id] — state-changing actions. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Never trust the body's playerId on its own: every action below is a write
  // on someone's game, and a bare id is public knowledge. A session token, when
  // present, decides who this is; without one the id must not belong to an
  // account. (lib/server/auth.ts)
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const playerId = acting.playerId;

  try {
    switch (body.action) {
      case "join":
        return NextResponse.json({ game: await joinHostedGame(id, playerId) });
      case "move":
        if (!body.move?.from || !body.move?.to) {
          return NextResponse.json(
            { error: "Move requires from and to squares" },
            { status: 400 },
          );
        }
        return NextResponse.json({
          game: await submitHostedMove(
            id,
            playerId,
            body.move.from,
            body.move.to,
            body.move.promotion,
          ),
        });
      case "resign":
        return NextResponse.json({ game: await resignHostedGame(id, playerId) });
      case "draw-offer":
        return NextResponse.json({ game: await offerDrawHostedGame(id, playerId) });
      case "draw-respond":
        return NextResponse.json({
          game: await respondHostedDraw(id, playerId, body.accept === true),
        });
      case "abort":
        return NextResponse.json({ game: await abortHostedGame(id, playerId) });
      case "rematch":
        return NextResponse.json({ game: await rematchHostedGame(id, playerId) });
      case "timeout":
        // Settle a flag fall now (server-authoritative clock check).
        return NextResponse.json({
          game: await getHostedGame(id).then((g) => {
            if (!g) throw new Error("Game not found");
            return g;
          }),
        });
      case "summary":
        return NextResponse.json({ game: await summarizeHostedGame(id) });
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
