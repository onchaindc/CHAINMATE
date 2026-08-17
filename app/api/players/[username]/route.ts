import { NextRequest, NextResponse } from "next/server";
import { getPlayerProfile } from "@/lib/server/hosted";
import { supabaseConfigured } from "@/lib/supabase/config";
import {
  friendshipStatus,
  listFriendIds,
  playerProfileByUsername,
} from "@/lib/supabase/db";
import { getPlayerStats } from "@/lib/server/hosted";
import type { PlayerStats } from "@/lib/types";

export const runtime = "nodejs";

type Params = { params: Promise<{ username: string }> };

/** Enrich a set of player ids with their public stats. */
async function statsForIds(ids: string[]): Promise<PlayerStats[]> {
  const out: PlayerStats[] = [];
  for (const id of ids) {
    if (!id) continue;
    try {
      out.push(await getPlayerStats(id));
    } catch {
      // skip unreadable players
    }
  }
  return out;
}

/**
 * GET /api/players/[username]?viewer=… — the public profile of a ChainMate
 * player: real stats, recent games, friends, and the friendship status
 * between the viewer (if any) and this player.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { username } = await params;
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Accounts aren't configured on this deployment yet." },
      { status: 503 },
    );
  }
  const viewer = _req.nextUrl.searchParams.get("viewer") ?? "";

  try {
    const profile = await playerProfileByUsername(username);
    if (!profile) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }

    const playerId = profile.player_id;
    const [profileData, friends] = await Promise.all([
      getPlayerProfile(playerId),
      listFriendIds(playerId).then((ids) => statsForIds(ids)),
    ]);

    const status = viewer
      ? await friendshipStatus(viewer, playerId)
      : ("none" as const);

    return NextResponse.json({
      player: {
        playerId,
        username: profile.username,
        isGuest: profile.is_guest,
        country: profile.country,
        rating: profile.rating,
        peakRating: profile.peak_rating,
        wins: profile.wins,
        losses: profile.losses,
        draws: profile.draws,
        games: profile.games,
        currentStreak: profile.current_streak,
        bestStreak: profile.best_streak,
        createdAt: profile.created_at,
      },
      stats: profileData.stats,
      games: profileData.games,
      players: profileData.players,
      friends,
      friendship: status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load profile";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
