import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
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

  // Same rule as the action route: creating a game in someone else's name would
  // put a rated match on their record.
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const playerId = acting.playerId;

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
      const { games, players } = await listHostedGames({
        playerId,
        accountPlayerId,
        scope: "mine",
      });
      // `players` carries the usernames for these games' participants. Dropping
      // it here is what made every row render a generic guest label.
      return NextResponse.json({ games: games ?? [], players: players ?? {} });
    }
    if (scope === "watch") {
      const { live, open, recent, players } = await listHostedGames({ scope: "watch" });
      return NextResponse.json({
        live: live ?? [],
        open: open ?? [],
        recent: recent ?? [],
        players: players ?? {},
      });
    }
    if (scope === "recent") {
      const { games, players } = await listHostedGames({ scope: "recent" });
      return NextResponse.json({ games: games ?? [], players: players ?? {} });
    }
    const { games, players } = await listHostedGames({ playerId });
    return NextResponse.json({ games: games ?? [], players: players ?? {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list games";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
