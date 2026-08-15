import { NextRequest, NextResponse } from "next/server";
import {
  getHostedGame,
  joinHostedGame,
  resignHostedGame,
  submitHostedMove,
  summarizeHostedGame,
} from "@/lib/server/hosted";

export const runtime = "nodejs";

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
  action: "join" | "move" | "resign" | "summary";
  playerId?: string;
  move?: { from: string; to: string; promotion?: string };
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

  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) {
    return NextResponse.json(
      { error: "playerId is required — send your browser's player identity" },
      { status: 400 },
    );
  }

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
