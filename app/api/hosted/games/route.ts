import { NextRequest, NextResponse } from "next/server";
import { createHostedGame, listHostedGames } from "@/lib/server/hosted";

export const runtime = "nodejs";

interface CreateBody {
  playerId?: string;
  timeControl?: string;
  visibility?: "public" | "private";
}

/** POST /api/hosted/games — create a shared multiplayer game. */
export async function POST(req: NextRequest) {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
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
    const game = await createHostedGame(playerId, {
      timeControl: typeof body.timeControl === "string" ? body.timeControl : undefined,
      visibility: body.visibility === "public" ? "public" : "private",
    });
    return NextResponse.json({ game });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create game";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/hosted/games?scope=mine&playerId=…  → the player's games
 * GET /api/hosted/games?scope=watch             → public live + recent matches
 * GET /api/hosted/games?scope=recent            → most recent completed games
 */
export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope");
  const playerId = req.nextUrl.searchParams.get("playerId") ?? undefined;
  const accountPlayerId =
    req.nextUrl.searchParams.get("accountPlayerId") ?? undefined;

  try {
    if (scope === "mine") {
      if (!playerId) {
        return NextResponse.json({ error: "playerId is required" }, { status: 400 });
      }
      const { games } = await listHostedGames({
        playerId,
        accountPlayerId,
        scope: "mine",
      });
      return NextResponse.json({ games: games ?? [] });
    }
    if (scope === "watch") {
      const { live, recent } = await listHostedGames({ scope: "watch" });
      return NextResponse.json({ live: live ?? [], recent: recent ?? [] });
    }
    if (scope === "recent") {
      const { games } = await listHostedGames({ scope: "recent" });
      return NextResponse.json({ games: games ?? [] });
    }
    const { games } = await listHostedGames({ playerId });
    return NextResponse.json({ games: games ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list games";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
