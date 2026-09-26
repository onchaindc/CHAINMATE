import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  abortHostedGame,
  arriveHostedGame,
  getHostedGame,
  joinHostedGame,
  offerDrawHostedGame,
  rematchHostedGame,
  resignHostedGame,
  respondHostedDraw,
  submitAiMove,
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

/** Body shape for the actions below. */
interface ActionBody {
  action:
    | "join"
    | "move"
    | "ai-move"
    | "resign"
    | "draw-offer"
    | "draw-respond"
    | "abort"
    | "rematch"
    | "timeout"
    | "arrive"
    | "summary";
  playerId?: string;
  move?: { from: string; to: string; promotion?: string };
  accept?: boolean;
}

/**
 * GET /api/hosted/games/[id] — read current game state.
 * GET /api/hosted/games/[id]?analysis=1 — drive the post-game analysis to
 * completion server-side (awaited) and return the game with the real result.
 * The client polls this after a game ends; the first poll runs the GenLayer
 * call, so analysis never depends on a browser tab staying open. Idempotent:
 * returns immediately once `analysis` (or a terminal `analysisError`) is set.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const runAnalysis = req.nextUrl.searchParams.get("analysis") === "1";
  try {
    const game = await getHostedGame(id);
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    if (runAnalysis) {
      const analysed = await summarizeHostedGame(id);
      analysed.serverNow = Date.now();
      return NextResponse.json({ game: analysed });
    }
    // serverNow: the server's own clock at serve time, carried ON the game so
    // every consumer sees it. The client store adjusts it for transport and
    // derives an offset, so live clocks tick in SERVER time — two devices
    // that disagree by seconds would otherwise watch two different matches.
    game.serverNow = Date.now();
    return NextResponse.json({ game });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load game";
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
      case "ai-move":
        // The bot's reply. Server-computed so the move lands in the shared
        // record (Watch, history) exactly like a human's — no client may
        // author it, and the same legality validation applies.
        return NextResponse.json({ game: await submitAiMove(id) });
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
      case "arrive":
        // Check in as present for a tournament board. Server-side only:
        // presence decides when the clock starts, so it can never be faked
        // by writing arrivedAt into a poll response.
        return NextResponse.json({ game: await arriveHostedGame(id, playerId) });
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
