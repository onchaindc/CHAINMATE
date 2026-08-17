import { NextRequest, NextResponse } from "next/server";
import {
  generateSummaryOnChain,
  getGameOnChain,
  joinGameOnChain,
  resignGameOnChain,
  signerAddress,
  submitMoveOnChain,
} from "@/lib/server/genlayer";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET /api/games/[id] — read current on-chain state. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const game = await getGameOnChain(id);
  if (!game) {
    return NextResponse.json({ error: "Game not found" }, { status: 404 });
  }
  return NextResponse.json({ game });
}

interface ActionBody {
  action: "join" | "move" | "resign" | "summary";
  /** The requesting player's app identity — never a slot number. */
  playerId?: string;
  move?: { from: string; to: string; promotion?: string };
}

/** POST /api/games/[id] — state-changing actions (signed server-side). */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: ActionBody;
  try {
    body = (await req.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
    if (body.action !== "summary" && !playerId) {
      return NextResponse.json(
        { error: "playerId is required — send your browser's player identity" },
        { status: 400 },
      );
    }
    switch (body.action) {
      case "join":
        return NextResponse.json({
          game: await joinGameOnChain(id, playerId),
          myId: signerAddress(2),
        });
      case "move":
        if (!body.move?.from || !body.move?.to) {
          return NextResponse.json(
            { error: "Move requires from and to squares" },
            { status: 400 },
          );
        }
        return NextResponse.json({
          game: await submitMoveOnChain(
            id,
            body.move.from,
            body.move.to,
            body.move.promotion,
            playerId,
          ),
        });
      case "resign":
        return NextResponse.json({
          game: await resignGameOnChain(id, playerId),
        });
      case "summary":
        return NextResponse.json({ game: await generateSummaryOnChain(id) });
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transaction failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
