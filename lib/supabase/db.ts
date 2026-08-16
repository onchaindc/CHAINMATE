// Server-only module — never import from client components.

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import type { GameState, PlayerStats } from "@/lib/types";

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
  const rows = statsList.map((s) => ({
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
  }));
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
      result:
        game.winner
          ? game.status === "resigned"
            ? "resignation"
            : "checkmate"
          : game.status === "stalemate"
            ? "stalemate"
            : "draw",
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
  const row = {
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
