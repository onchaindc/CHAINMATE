import { NextRequest, NextResponse } from "next/server";
import {
  acceptChallenge,
  createChallenge,
  declineChallenge,
  listIncomingChallenges,
} from "@/lib/server/hosted";

export const runtime = "nodejs";

/**
 * Direct challenges: "X challenged you", answered with Accept or Decline.
 *
 * GET  /api/challenges?playerId=…  → challenges waiting on this player
 * POST /api/challenges { playerId, action, … }
 */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId") ?? "";
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  try {
    const { challenges, players } = await listIncomingChallenges(playerId);
    return NextResponse.json({ challenges, players });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load challenges";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface ChallengeBody {
  playerId?: string;
  /** Target of a new challenge (action "create"). */
  opponentId?: string;
  /** The challenge being answered (actions "accept" / "decline"). */
  gameId?: string;
  timeControl?: string;
  action?: "create" | "accept" | "decline";
}

export async function POST(req: NextRequest) {
  let body: ChallengeBody;
  try {
    body = (await req.json()) as ChallengeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const playerId = (body.playerId ?? "").trim();
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "create": {
        const opponentId = (body.opponentId ?? "").trim();
        if (!opponentId) {
          return NextResponse.json(
            { error: "opponentId is required" },
            { status: 400 },
          );
        }
        const game = await createChallenge(playerId, opponentId, body.timeControl);
        return NextResponse.json({ game });
      }
      case "accept": {
        const gameId = (body.gameId ?? "").trim();
        if (!gameId) {
          return NextResponse.json({ error: "gameId is required" }, { status: 400 });
        }
        const game = await acceptChallenge(gameId, playerId);
        return NextResponse.json({ game });
      }
      case "decline": {
        const gameId = (body.gameId ?? "").trim();
        if (!gameId) {
          return NextResponse.json({ error: "gameId is required" }, { status: 400 });
        }
        await declineChallenge(gameId, playerId);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update the challenge";
    // A challenge that was already answered, or was never ours to answer, is a
    // conflict rather than a server fault — the client shows the message.
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
