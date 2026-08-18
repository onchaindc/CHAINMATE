// Server-only module — never import from client components.

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import type { GameState, GameStatus, PlayerStats } from "@/lib/types";

/**
 * Trusted writes to the Supabase persistence layer. Every function is
 * best-effort: callers wrap them in try/catch so a Supabase hiccup can never
 * break a chess game. Schema lives in supabase/migrations/0001_init.sql.
 */

export interface ProfileRow {
  user_id: string;
  player_id: string;
  username: string;
  is_guest: boolean;
  rating: number;
  /** Glicko rating deviation (confidence) — 350 provisional → 30 solid. */
  rd: number;
  /** Unix ms of the player's last rated game (drives RD decay). */
  last_played_at: number | null;
  /** Optional ISO 3166-1 alpha-2 country code (flag display only). */
  country: string | null;
  peak_rating: number;
  wins: number;
  losses: number;
  draws: number;
  games: number;
  current_streak: number;
  best_streak: number;
  created_at: string;
  updated_at: string;
}

/**
 * True when the tables exist (checked lazily so setup errors are readable).
 * `error` carries the underlying message when something is off (missing
 * table, network, permissions) — useful for surfacing setup issues.
 */
export async function supabaseSchemaReady(): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: "Supabase is not configured" };
  const { error } = await admin
    .from("profiles")
    .select("player_id")
    .limit(1);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function profileForUserId(userId: string): Promise<ProfileRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ProfileRow;
}

/**
 * Read a player's persisted record by their game-store player id. This is
 * the database-backed source of truth for ratings: the game store's KV is
 * fast-path storage, but when it misses (fresh instance, new device) the
 * rating comes from the profiles table instead of defaulting to 1200.
 */
export async function profileForPlayerId(playerId: string): Promise<ProfileRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("player_id", playerId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ProfileRow;
}

export async function usernameTaken(username: string, excludeUserId?: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  let q = admin.from("profiles").select("user_id").ilike("username", username);
  if (excludeUserId) q = q.neq("user_id", excludeUserId);
  const { data, error } = await q.limit(1);
  if (error) {
    // Surface the real problem (missing table, network, permissions) instead
    // of silently reporting "available".
    throw new Error(error.message);
  }
  return data !== null && data.length > 0;
}

/** Mirror player stats into profiles (guests included — all real players). */
export async function upsertProfiles(statsList: PlayerStats[]): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin || statsList.length === 0) return;
  const now = new Date().toISOString();
  const rows = statsList.map((s) => {
    // Only insert columns from the base migration (0001). Migration 0003
    // columns (rd, last_played_at, country) use schema defaults so this
    // works even if migration 0003 hasn't been run yet.
    return {
      player_id: s.playerId,
      username: s.username ?? `Guest_${s.playerId.slice(0, 4).toUpperCase()}`,
      is_guest: s.isGuest ?? true,
      rating: s.rating,
      peak_rating: s.peakRating,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      games: s.games,
      current_streak: s.currentStreak,
      best_streak: s.bestStreak,
      updated_at: now,
    };
  });
  await admin.from("profiles").upsert(rows, { onConflict: "player_id" });
}

/** Mirror a completed game into the games history table. */
export async function upsertGameRecord(game: GameState): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  await admin.from("games").upsert(
    {
      id: game.id,
      white_player_id: game.creator,
      black_player_id: game.opponent || "",
      time_control: game.timeControl ?? null,
      status: game.status,
      result: resultLabel(game.status),
      winner_player_id: game.winner || "",
      created_at: game.createdAt ?? Date.now(),
      started_at: game.startedAt ?? null,
      ended_at: game.endedAt ?? null,
      moves: JSON.stringify(game.moves),
      summary: game.summary || "",
    },
    { onConflict: "id" },
  );
}

/** The real termination reason, never guessed from the winner alone. */
function resultLabel(status: GameStatus): string {
  const result: Record<string, string> = {
    checkmate: "checkmate",
    stalemate: "stalemate",
    draw: "draw",
    resigned: "resignation",
    timeout: "timeout",
    aborted: "aborted",
  };
  return result[status] ?? status;
}

/**
 * Mirror the FULL game state (live or finished) into the games table. This is
 * the durability layer for multiplayer: every mutation writes a snapshot here
 * best-effort, and the server restores the game from this table when the fast
 * store (KV / file store) misses it — so a serverless cold start or storage
 * reset can never produce a mid-game "Game not found".
 */
export async function upsertGameSnapshot(game: GameState): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  await admin.from("games").upsert(
    {
      id: game.id,
      white_player_id: game.creator,
      black_player_id: game.opponent || "",
      time_control: game.timeControl ?? null,
      status: game.status,
      result: resultLabel(game.status),
      winner_player_id: game.winner || "",
      created_at: game.createdAt ?? Date.now(),
      started_at: game.startedAt ?? null,
      ended_at: game.endedAt ?? null,
      moves: JSON.stringify(game.moves),
      summary: game.summary || "",
      snapshot: JSON.stringify(game),
    },
    { onConflict: "id" },
  );
}

function parseSnapshot(raw: unknown): GameState | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as GameState;
  } catch {
    return null;
  }
}

/** Restore a full game by id from the snapshot table (null when absent). */
export async function gameSnapshotById(id: string): Promise<GameState | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("games")
    .select("snapshot")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return parseSnapshot(data.snapshot);
}

/** Recent game snapshots (newest first), optionally filtered by status. */
export async function recentGameSnapshots(
  limit: number,
  status?: GameStatus,
): Promise<GameState[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  let q = admin
    .from("games")
    .select("snapshot")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error || !data) return [];
  const out: GameState[] = [];
  for (const row of data) {
    const game = parseSnapshot(row.snapshot);
    if (game) out.push(game);
  }
  return out;
}

/** Persist awarded achievements for a player (trusted server-side records). */
export async function upsertAchievements(stats: PlayerStats): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const rows = (stats.achievements ?? []).map((a) => ({
    player_id: stats.playerId,
    code: a.code,
    earned_at: a.earnedAt,
  }));
  if (rows.length === 0) return;
  await admin
    .from("player_achievements")
    .upsert(rows, { onConflict: "player_id,code" });
}

/** Create/update the permanent profile for a freshly-signed-in account. */
export async function linkProfileToAccount(input: {
  userId: string;
  playerId: string;
  username: string;
  stats: PlayerStats;
}): Promise<ProfileRow> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("Account creation isn't configured yet.");
  const now = new Date().toISOString();
  // Only insert columns from the base migration (0001). Columns added by
  // migration 0003 (rd, last_played_at, country) use their schema defaults
  // so the insert works even if the user hasn't run migration 0003 yet.
  const row: Record<string, unknown> = {
    user_id: input.userId,
    player_id: input.playerId,
    username: input.username,
    is_guest: false,
    rating: input.stats.rating,
    peak_rating: input.stats.peakRating,
    wins: input.stats.wins,
    losses: input.stats.losses,
    draws: input.stats.draws,
    games: input.stats.games,
    current_streak: input.stats.currentStreak,
    best_streak: input.stats.bestStreak,
    created_at: now,
    updated_at: now,
  };
  // Only add 0003 columns if they appear to exist (best-effort).
  // If the columns don't exist, Supabase would reject the insert, so we
  // try inserting without them first and update separately if needed.
  const { data, error } = await admin
    .from("profiles")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .maybeSingle();
  if (error || !data) {
    throw new Error("We couldn't save your profile. Please try again.");
  }
  return data as unknown as ProfileRow;
}

/** Update the optional country flag on a player's profile (display only). */
export async function setPlayerCountry(
  playerId: string,
  country: string | null,
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  await admin
    .from("profiles")
    .update({ country: country || null, updated_at: new Date().toISOString() })
    .eq("player_id", playerId);
}

/* ------------------------------------------------------------------ */
/* Player search + public profiles                                     */
/* ------------------------------------------------------------------ */

export interface PlayerSearchResult {
  player_id: string;
  username: string;
  is_guest: boolean;
  rating: number;
  country: string | null;
  games: number;
}

/** Search ChainMate accounts by username fragment (case-insensitive). */
export async function searchPlayersByUsername(
  query: string,
  limit = 10,
): Promise<PlayerSearchResult[]> {
  const admin = getSupabaseAdmin();
  if (!admin || query.trim().length < 1) return [];
  const { data, error } = await admin
    .from("profiles")
    .select("player_id, username, is_guest, rating, country, games")
    .ilike("username", `%${query.trim()}%`)
    .order("rating", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as unknown as PlayerSearchResult[];
}

/** Look up a profile by exact username (case-insensitive). */
export async function playerProfileByUsername(
  username: string,
): Promise<ProfileRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .ilike("username", username)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ProfileRow;
}

/* ------------------------------------------------------------------ */
/* Friendships (persistent, server-written)                            */
/* ------------------------------------------------------------------ */

export type FriendshipStatus = "pending" | "accepted" | "rejected";

export interface FriendshipRow {
  requester_player_id: string;
  addressee_player_id: string;
  status: FriendshipStatus;
  created_at: number;
  responded_at: number | null;
}

async function friendshipBetween(
  a: string,
  b: string,
): Promise<FriendshipRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("friendships")
    .select("*")
    .or(`requester_player_id.eq.${a},addressee_player_id.eq.${a}`)
    .or(`requester_player_id.eq.${b},addressee_player_id.eq.${b}`)
    .limit(4);
  if (error || !data) return null;
  const rows = data as unknown as FriendshipRow[];
  return (
    rows.find(
      (r) =>
        (r.requester_player_id === a && r.addressee_player_id === b) ||
        (r.requester_player_id === b && r.addressee_player_id === a),
    ) ?? null
  );
}

/**
 * The friendship status between two players from `me`'s perspective:
 * "none" | "requested" (I asked) | "incoming" (they asked) | "friends".
 */
export async function friendshipStatus(
  me: string,
  other: string,
): Promise<"none" | "requested" | "incoming" | "friends"> {
  const row = await friendshipBetween(me, other);
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  if (row.requester_player_id === me) return "requested";
  return "incoming";
}

/** Send a friend request. Accepts silently when the other side already asked. */
export async function requestFriend(
  requesterId: string,
  addresseeId: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: "Accounts aren't configured yet." };
  if (requesterId === addresseeId) return { ok: false, error: "You can't add yourself." };

  const existing = await friendshipBetween(requesterId, addresseeId);
  if (existing?.status === "accepted") {
    return { ok: false, error: "You're already friends." };
  }
  if (existing?.requester_player_id === requesterId && existing.status === "pending") {
    return { ok: false, error: "Request already sent — waiting for a reply." };
  }
  if (existing?.addressee_player_id === requesterId && existing.status === "pending") {
    // They asked first — just accept instead of stacking a duplicate.
    await admin
      .from("friendships")
      .update({ status: "accepted", responded_at: Date.now() })
      .eq("requester_player_id", addresseeId)
      .eq("addressee_player_id", requesterId);
    return { ok: true };
  }

  // Clear any stale row (rejected / old direction) so the pair stays unique.
  await admin
    .from("friendships")
    .delete()
    .or(`requester_player_id.eq.${requesterId},requester_player_id.eq.${addresseeId}`)
    .or(`addressee_player_id.eq.${requesterId},addressee_player_id.eq.${addresseeId}`);

  const { error } = await admin.from("friendships").insert({
    requester_player_id: requesterId,
    addressee_player_id: addresseeId,
    status: "pending",
    created_at: Date.now(),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Accept or reject a pending request addressed to `playerId`. */
export async function respondFriend(
  playerId: string,
  otherId: string,
  accept: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: "Accounts aren't configured yet." };
  const { error } = await admin
    .from("friendships")
    .update({ status: accept ? "accepted" : "rejected", responded_at: Date.now() })
    .eq("requester_player_id", otherId)
    .eq("addressee_player_id", playerId)
    .eq("status", "pending");
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Remove an accepted friendship (or cancel a pending request). */
export async function removeFriend(
  playerId: string,
  otherId: string,
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: "Accounts aren't configured yet." };
  const { error } = await admin
    .from("friendships")
    .delete()
    .or(`requester_player_id.eq.${playerId},requester_player_id.eq.${otherId}`)
    .or(`addressee_player_id.eq.${playerId},addressee_player_id.eq.${otherId}`);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** All accepted friend player-ids for a player. */
export async function listFriendIds(playerId: string): Promise<string[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("friendships")
    .select("*")
    .or(`requester_player_id.eq.${playerId},addressee_player_id.eq.${playerId}`)
    .eq("status", "accepted")
    .limit(200);
  if (error || !data) return [];
  const rows = data as unknown as FriendshipRow[];
  return rows.map((r) =>
    r.requester_player_id === playerId ? r.addressee_player_id : r.requester_player_id,
  );
}

/** Pending requests addressed to this player (from others). */
export async function listIncomingRequests(playerId: string): Promise<string[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("friendships")
    .select("requester_player_id")
    .eq("addressee_player_id", playerId)
    .eq("status", "pending")
    .limit(50);
  if (error || !data) return [];
  return (data as unknown as { requester_player_id: string }[]).map(
    (r) => r.requester_player_id,
  );
}
