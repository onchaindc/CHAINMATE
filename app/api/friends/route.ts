import { NextRequest, NextResponse } from "next/server";
import { getPlayerStats } from "@/lib/server/hosted";
import { supabaseConfigured } from "@/lib/supabase/config";
import {
  listFriendIds,
  listIncomingRequests,
  removeFriend,
  requestFriend,
  respondFriend,
} from "@/lib/supabase/db";
import type { PlayerStats } from "@/lib/types";

export const runtime = "nodejs";

/** Enrich player ids with public stats (username, rating, country). */
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

/** GET /api/friends?playerId=… — accepted friends + incoming requests. */
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get("playerId") ?? "";
  if (!playerId) {
    return NextResponse.json({ error: "playerId is required" }, { status: 400 });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Accounts aren't configured on this deployment yet." },
      { status: 503 },
    );
  }
  try {
    const [friendIds, incomingIds] = await Promise.all([
      listFriendIds(playerId),
      listIncomingRequests(playerId),
    ]);
    const [friends, incoming] = await Promise.all([
      statsForIds(friendIds),
      statsForIds(incomingIds),
    ]);
    return NextResponse.json({ friends, incoming });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load friends";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface FriendBody {
  playerId?: string;
  otherId?: string;
  action?: "request" | "accept" | "decline" | "remove";
}

/** POST /api/friends { playerId, otherId, action } — friend mutations. */
export async function POST(req: NextRequest) {
  let body: FriendBody;
  try {
    body = (await req.json()) as FriendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const playerId = (body.playerId ?? "").trim();
  const otherId = (body.otherId ?? "").trim();
  if (!playerId || !otherId) {
    return NextResponse.json(
      { error: "playerId and otherId are required" },
      { status: 400 },
    );
  }
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Accounts aren't configured on this deployment yet." },
      { status: 503 },
    );
  }
  try {
    let result: { ok: boolean; error?: string };
    switch (body.action) {
      case "request":
        result = await requestFriend(playerId, otherId);
        break;
      case "accept":
        result = await respondFriend(playerId, otherId, true);
        break;
      case "decline":
        result = await respondFriend(playerId, otherId, false);
        break;
      case "remove":
        result = await removeFriend(playerId, otherId);
        break;
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update friends";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
