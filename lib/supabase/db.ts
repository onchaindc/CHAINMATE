// Server-only module — never import from client components.

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { displaySummary } from "@/lib/summary";
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

export async function usernameTaken(username: string, excludeUserId?: string, excludePlayerId?: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  let q = admin.from("profiles").select("user_id, player_id").ilike("username", username);
  if (excludeUserId) {
    // NULL-safe exclusion. A plain .neq("user_id", x) compiles to
    // `user_id <> x`, which evaluates to NULL — not true — for guest rows,
    // where user_id IS NULL. Postgres drops those rows, so a name already
    // held by a guest would read as "available" here and then violate
    // profiles_username_lower_idx (a global unique index on lower(username),
    // which guests share) on insert: a 500 instead of a clean 409.
    // Keep a row when it belongs to a guest OR to a different account.
    //
    // .or() takes a raw PostgREST filter string, so the value is interpolated
    // rather than bound. Callers pass a Supabase auth UUID, but this is an
    // exported helper — validate the shape instead of trusting every future
    // caller. A non-UUID would be a bug, so fail loudly rather than silently
    // widening the query.
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(excludeUserId)) {
      throw new Error("usernameTaken: excludeUserId must be a UUID");
    }
    q = q.or(`user_id.is.null,user_id.neq.${excludeUserId}`);
  }
  // player_id is `not null` in 0001, so .neq() needs no NULL guard here.
  if (excludePlayerId) q = q.neq("player_id", excludePlayerId);
  const { data, error } = await q.limit(1);
  if (error) {
    // Surface the real problem (missing table, network, permissions) instead
    // of silently reporting "available".
    throw new Error(error.message);
  }
  return data !== null && data.length > 0;
}

/**
 * Mirror player stats into profiles (guests included — all real players).
 *
 * This is the *durable* record of a rating: the game store's KV is per-instance
 * fast-path storage, so a rating that only lands there is invisible to any
 * request served elsewhere. That means `rd` and `last_played_at` have to be
 * written here too — a rating without its deviation resets to provisional on
 * the next instance, and every subsequent game swings by a hundred points.
 *
 * Those two columns arrived in migration 0003, so if the write is rejected for
 * an unknown column the row is retried with the 0001 column set instead. That
 * keeps ratings persisting on an older schema rather than silently dropping
 * every update.
 */
export async function upsertProfiles(statsList: PlayerStats[]): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin || statsList.length === 0) return;
  const now = new Date().toISOString();
  const base = statsList.map((s) => ({
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
  const rows = base.map((row, i) => ({
    ...row,
    rd: statsList[i].rd ?? null,
    last_played_at: statsList[i].lastPlayedAt ?? null,
  }));

  const { error } = await admin.from("profiles").upsert(rows, { onConflict: "player_id" });
  if (!error) return;
  // Missing column (migration 0003 not applied) — keep the rating itself.
  const { error: fallbackError } = await admin
    .from("profiles")
    .upsert(base, { onConflict: "player_id" });
  if (fallbackError) throw new Error(fallbackError.message);
}

/**
 * The ranked player list, straight from the durable profiles table.
 *
 * The game store keeps its own leaderboard blob, but that lives in
 * per-instance storage — on a multi-instance host it only ever holds the
 * players whose games happened to finish on the instance answering the
 * request. Ranking has to come from the database to be the same list for
 * everyone. Guests are excluded: their games are casual and unrated.
 */
export async function leaderboardProfiles(limit: number): Promise<PlayerStats[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("is_guest", false)
    .gt("games", 0)
    .order("rating", { ascending: false })
    .order("games", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as unknown as ProfileRow[]).map((row) => ({
    playerId: row.player_id,
    username: row.username,
    isGuest: row.is_guest,
    country: row.country ?? undefined,
    rating: row.rating,
    rd: row.rd ?? undefined,
    lastPlayedAt: row.last_played_at ?? null,
    peakRating: row.peak_rating,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    games: row.games,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    ratingHistory: [],
    achievements: [],
    updatedAt: new Date(row.updated_at).getTime() || Date.now(),
  }));
}

/**
 * Report a write that Supabase rejected.
 *
 * Every durable write here is best-effort by design — the fast store already
 * answered the request, so a failed mirror must not break the user's move. But
 * "best-effort" was implemented as "unexamined", which meant a schema drift or a
 * revoked permission would have degraded the whole app to per-instance memory in
 * total silence: no error, no log, nothing to search for. One line in the
 * function log is what makes that diagnosable.
 */
function reportWriteError(op: string, error: unknown): void {
  if (!error) return;
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  console.warn(`[chainmate] supabase ${op} failed: ${message}`);
}

/** Mirror a completed game into the games history table. */
export async function upsertGameRecord(game: GameState): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin.from("games").upsert(
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
      summary: displaySummary(game),
    },
    { onConflict: "id" },
  );
  reportWriteError(`upsertGameRecord(${game.id})`, error);
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
  const { error } = await admin.from("games").upsert(
    {
      id: game.id,
      white_player_id: game.creator,
      // A directed challenge names its target here while the game is still
      // `waiting`, which is how the invited player finds it from any instance.
      // The moment they accept, `opponent` is set and takes over.
      black_player_id: game.opponent || game.invited || "",
      time_control: game.timeControl ?? null,
      status: game.status,
      result: resultLabel(game.status),
      winner_player_id: game.winner || "",
      created_at: game.createdAt ?? Date.now(),
      started_at: game.startedAt ?? null,
      ended_at: game.endedAt ?? null,
      moves: JSON.stringify(game.moves),
      summary: displaySummary(game),
      snapshot: JSON.stringify(game),
    },
    { onConflict: "id" },
  );
  reportWriteError(`upsertGameSnapshot(${game.id})`, error);
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

/**
 * Every game one player took part in, newest first.
 *
 * This is the durable answer to "show me my games", and it has to come from
 * here rather than from the game store's index blob. That blob lives in
 * per-instance storage (KV when configured, otherwise an in-memory file store
 * that cannot write to a read-only serverless filesystem), so on a
 * multi-instance host it only ever holds the games that happened to be played
 * on the instance answering the request — a player's newest match is routinely
 * invisible to it, which is exactly what made a freshly finished game vanish
 * from Games and from the profile page.
 *
 * `games_white_idx` and `games_black_idx` (migration 0001) cover both sides of
 * the OR. Pool placeholders are excluded: `hosted_s…` rows exist to hold a
 * place in the matchmaking queue and are not games anybody played.
 */
export async function gamesForPlayer(
  playerIds: string[],
  limit: number,
): Promise<GameState[]> {
  const admin = getSupabaseAdmin();
  const ids = [...new Set(playerIds.filter(Boolean))];
  if (!admin || ids.length === 0) return [];
  // PostgREST .or() takes a raw filter string, so the ids are interpolated
  // rather than bound. Player ids are generated server-side (`acct_…`) or by
  // the client identity (`0x…`), but this is an exported helper — reject
  // anything that could break out of the filter list instead of trusting
  // every future caller.
  if (ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) {
    throw new Error("gamesForPlayer: player ids must be alphanumeric");
  }
  const filter = ids
    .flatMap((id) => [`white_player_id.eq.${id}`, `black_player_id.eq.${id}`])
    .join(",");
  const { data, error } = await admin
    .from("games")
    .select("snapshot")
    .or(filter)
    .not("id", "like", `${SEEK_ID_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const out: GameState[] = [];
  for (const row of data) {
    const game = parseSnapshot(row.snapshot);
    if (game) out.push(game);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Matchmaking pool + direct challenges (durable, cross-instance)      */
/* ------------------------------------------------------------------ */

/**
 * Both the seek pool and pending challenges live in the `games` table, as real
 * `waiting` rows. That is deliberate:
 *
 *  - The fast store (KV / file store) is per-instance on a serverless host, so
 *    a seek pool kept there is invisible to the instance answering the *other*
 *    player's request. That is exactly why two people could hit Search at the
 *    same moment and both sit there searching forever.
 *  - A `waiting` row already *is* a joinable game, and PostgREST folds filters
 *    on an UPDATE into its WHERE clause — so `status = 'waiting'` doubles as the
 *    lock. Of two players claiming the same row in the same instant, exactly one
 *    gets a row back and the other gets none and moves on.
 *  - It needs no new table, so none of this waits on a migration.
 *
 * A pool row is told apart from an ordinary open game by its id prefix; a
 * challenge is told apart by naming the invited player in `black_player_id`
 * while the row is still `waiting`.
 */
export const SEEK_ID_PREFIX = "hosted_s";

/** One player waiting in the pool. */
export interface SeekRow {
  id: string;
  white_player_id: string;
  time_control: string | null;
  created_at: number;
}

/** Every *other* player's live pool row, longest-waiting first. */
export async function openSeekRows(
  excludePlayerId: string,
  since: number,
  limit = 24,
): Promise<SeekRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("games")
    .select("id, white_player_id, time_control, created_at")
    .like("id", `${SEEK_ID_PREFIX}%`)
    .eq("status", "waiting")
    .eq("black_player_id", "")
    .neq("white_player_id", excludePlayerId)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return data as unknown as SeekRow[];
}

/**
 * My own live pool row — `status` says whether somebody claimed it, and
 * `created_at` is how long I have been queuing (the pairing window widens with
 * the wait, see seekInPool in lib/server/hosted.ts).
 */
export async function mySeekRow(
  playerId: string,
  since: number,
): Promise<{ id: string; status: string; created_at: number } | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("games")
    .select("id, status, created_at")
    .like("id", `${SEEK_ID_PREFIX}%`)
    .eq("white_player_id", playerId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as { id: string; status: string; created_at: number };
}

/**
 * Take a `waiting` row as Black and start the game. Returns the started game,
 * or null when another player won the race (or the row is gone) — the `.eq`
 * filters are the lock, so a loser simply gets no rows back.
 *
 * `expectBlack` is the value black_player_id must still hold: "" for a pool row
 * anyone may take, or the invited player's id for a directed challenge, so a
 * challenge can only ever be accepted by the player it was sent to.
 */
export async function claimWaitingRow(
  id: string,
  blackPlayerId: string,
  at: number,
  expectBlack = "",
): Promise<GameState | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("games")
    .update({
      black_player_id: blackPlayerId,
      status: "active",
      result: "active",
      started_at: at,
    })
    .eq("id", id)
    .eq("status", "waiting")
    .eq("black_player_id", expectBlack)
    .select("snapshot");
  if (error || !data || data.length === 0) return null;
  const stored = parseSnapshot(data[0].snapshot);
  if (!stored) return null;
  // The snapshot column still holds the waiting state — bring it in line with
  // the row we just won so every instance reads the same started game. Pool and
  // challenge games are broadcast like any other live match once they begin.
  const started: GameState = {
    ...stored,
    opponent: blackPlayerId,
    status: "active",
    visibility: "public",
    startedAt: at,
    updatedAt: at,
  };
  await upsertGameSnapshot(started);
  return started;
}

/** Leave the pool. False when the row is no longer waiting (already claimed). */
export async function withdrawSeekRow(id: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const { data, error } = await admin
    .from("games")
    .delete()
    .eq("id", id)
    .eq("status", "waiting")
    .eq("black_player_id", "")
    .select("id");
  return !error && Array.isArray(data) && data.length > 0;
}

/**
 * Drop all of my waiting pool rows (cancel, or before re-registering).
 *
 * Best-effort by design — a row we fail to delete ages out of the pool via
 * pruneStaleSeekRows, so matchmaking recovers on its own and nothing here is
 * worth failing a search over. Logged rather than thrown for that reason, but
 * logged: a delete that keeps failing shows up as ghost opponents in the pool,
 * and that is otherwise indistinguishable from a matchmaking bug.
 */
export async function dropSeekRows(playerId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin || !playerId) return;
  const { error } = await admin
    .from("games")
    .delete()
    .like("id", `${SEEK_ID_PREFIX}%`)
    .eq("white_player_id", playerId)
    .eq("status", "waiting");
  reportWriteError(`dropSeekRows(${playerId})`, error);
}

/** Clear pool rows nobody came back for, so the pool never rots. */
export async function pruneStaleSeekRows(before: number): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("games")
    .delete()
    .like("id", `${SEEK_ID_PREFIX}%`)
    .eq("status", "waiting")
    .lt("created_at", before);
  reportWriteError("pruneStaleSeekRows", error);
}

/**
 * Durable rating *and* confidence for a set of player ids (players with no row
 * are omitted). Matchmaking needs the deviation as well as the rating: a
 * provisional opponent is matchable across a much wider gap than an established
 * one, and judging that from the searcher's own rd alone deadlocks the pair.
 */
export async function ratingsForPlayerIds(
  ids: string[],
): Promise<Record<string, { rating: number; rd: number }>> {
  const admin = getSupabaseAdmin();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!admin || unique.length === 0) return {};
  const { data, error } = await admin
    .from("profiles")
    .select("player_id, rating, rd")
    .in("player_id", unique);
  if (error || !data) return {};
  const out: Record<string, { rating: number; rd: number }> = {};
  for (const row of data as unknown as {
    player_id: string;
    rating: number;
    rd: number | null;
  }[]) {
    out[row.player_id] = { rating: row.rating, rd: row.rd ?? 350 };
  }
  return out;
}

/** Challenges addressed to this player and still awaiting an answer. */
export async function incomingChallengeSnapshots(
  playerId: string,
  since: number,
  limit = 5,
): Promise<GameState[]> {
  const admin = getSupabaseAdmin();
  if (!admin || !playerId) return [];
  const { data, error } = await admin
    .from("games")
    .select("snapshot")
    .eq("black_player_id", playerId)
    .eq("status", "waiting")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const out: GameState[] = [];
  for (const row of data) {
    const game = parseSnapshot(row.snapshot);
    if (game) out.push(game);
  }
  return out;
}

/** A challenge this player already has outstanding to the same opponent. */
export async function outgoingChallengeSnapshot(
  fromPlayerId: string,
  toPlayerId: string,
  since: number,
): Promise<GameState | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("games")
    .select("snapshot")
    .eq("white_player_id", fromPlayerId)
    .eq("black_player_id", toPlayerId)
    .eq("status", "waiting")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return parseSnapshot(data.snapshot);
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
  const { error } = await admin
    .from("player_achievements")
    .upsert(rows, { onConflict: "player_id,code" });
  reportWriteError(`upsertAchievements(${stats.playerId})`, error);
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

  // Check if a profile already exists for this user_id (e.g. from a
  // previous session). If so, update it in place — the PK is user_id,
  // so a second insert would fail with a unique violation.
  const existing = await profileForUserId(input.userId);
  if (existing) {
    const { data, error } = await admin
      .from("profiles")
      .update({
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
        updated_at: now,
      })
      .eq("user_id", input.userId)
      .select("*")
      .maybeSingle();
    if (error || !data) {
      throw new Error("We couldn't save your profile. Please try again.");
    }
    return data as unknown as ProfileRow;
  }

  // New profile: insert columns from the base migration (0001). Columns
  // added by migration 0003 (rd, last_played_at, country) use their
  // schema defaults so the insert works even without migration 0003.
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
  const { data, error } = await admin
    .from("profiles")
    .upsert(row, { onConflict: "player_id" })
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
  const { error } = await admin
    .from("profiles")
    .update({ country: country || null, updated_at: new Date().toISOString() })
    .eq("player_id", playerId);
  reportWriteError(`setPlayerCountry(${playerId})`, error);
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
    //
    // Checked, unlike before: this branch returned { ok: true } whatever
    // happened, so a rejected update told the player the request was accepted
    // while the row stayed pending. They saw a friend who never appeared in
    // either list and no way to retry — the button was gone.
    const { error } = await admin
      .from("friendships")
      .update({ status: "accepted", responded_at: Date.now() })
      .eq("requester_player_id", addresseeId)
      .eq("addressee_player_id", requesterId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  // Clear any stale row (rejected / old direction) so the pair stays unique.
  // Worth reporting rather than ignoring: the insert below is what enforces one
  // row per pair, so a failed delete here comes back as a unique-violation on
  // the insert instead, and "duplicate key value violates constraint" is not a
  // sentence to show a player who clicked Add friend.
  const { error: staleError } = await admin
    .from("friendships")
    .delete()
    .or(`requester_player_id.eq.${requesterId},requester_player_id.eq.${addresseeId}`)
    .or(`addressee_player_id.eq.${requesterId},addressee_player_id.eq.${addresseeId}`);
  if (staleError) return { ok: false, error: staleError.message };

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
