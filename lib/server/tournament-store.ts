// Server-only module — never import from client components.

import { getGameStorage } from "@/lib/server/storage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import { randomHex } from "@/lib/utils";
import type {
  StandingRow,
  TournamentEntry,
  TournamentFormat,
  TournamentMatch,
  TournamentStatus,
  TournamentSummary,
} from "@/lib/tournament-types";
import { TOURNAMENT_FORMATS } from "@/lib/tournament-types";

/**
 * Tournament persistence — the durable side of the tournament engine.
 *
 * Pattern: exactly like lib/server/hosted.ts. The fast store (Vercel KV when
 * configured, otherwise the built-in .data/ file store) holds the whole
 * tournament document under `chainmate:tournament:<id>`, and every mutation
 * is a read-modify-write serialised through the storage layer. The single
 * document per tournament is what keeps registration counts, pairings and
 * standings consistent with each other — there is no second copy to drift.
 *
 * Concurrency: this file store (and KV) serve every request through one
 * serialized chain per process, so read-modify-write inside one async function
 * cannot interleave with another write to the same document *within an
 * instance*. Cross-instance races (the case that matters in production) are
 * handled where they can be: Supabase writes use conditional updates, and
 * status transitions re-check the current status after the read and before the
 * write (see lib/server/tournaments.ts). A join racing a start, for instance,
 * re-validates the tournament status it read — a join that read REGISTRATION
 * but whose document write lands after the transition to IN_PROGRESS is
 * discarded on its next read because the authoritative status field moved.
 *
 * Payment boundary: `entry_fee_nim` exists in the durable schema as a nullable
 * reserved column ONLY, documented for Phase 2B. Nothing in this phase writes
 * or reads it, and the fast-store document never carries it.
 */

const KEY_PREFIX = "chainmate:tournament:";
const INDEX_KEY = "chainmate:index:tournaments:v1";
const INDEX_MAX = 200;

/** The whole mutable state of one tournament, in one document. */
export interface TournamentDocument {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  format: TournamentFormat;
  timeControl: string;
  maxPlayers: number;
  status: TournamentStatus;
  /** Swiss only: configured number of rounds. */
  swissRounds: number | null;
  createdAt: number;
  /** When registration closes (null = manual close only). */
  registrationClosesAt: number | null;
  /**
   * Scheduled start (Unix ms). When set, the event auto-opens registration
   * at this instant (DRAFT → REGISTRATION) and the UI counts down to it.
   * Purely a convenience — the host can still open/start manually earlier.
   */
  scheduledStartAt: number | null;
  /**
   * Arena end (Unix ms). When the window passes, the event finalizes
   * automatically — standings freeze, prizes plan, no manual click needed.
   * Null = host-controlled (manual end).
  */
  scheduledEndAt: number | null;
  /** Server-stored reason for cancellation (deadline miss, host action…). */
  cancelReason: string | null;
  /**
   * Host's creation-time choice: when the field reaches maxPlayers during
   * registration, lock + start immediately instead of waiting for the
   * scheduled start or a manual host action. Default false.
   */
  startWhenFull: boolean;
  /**
   * Minimum players for this event: max(2, advertised prize positions) for
   * paid events. Below it, deadline expiry cancels + refunds.
   */
  minPlayers: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** Current round while in progress (1-based). */
  currentRound: number;
  totalRounds: number;
  /** Server-determined winner (never client-set). */
  winnerId: string | null;
  entries: TournamentEntry[];
  matches: TournamentMatch[];
  /** Last computed standings snapshot (recomputed on every result). */
  standings: StandingRow[];
  /**
   * Phase 2B economy. EXACT entry fee in luna (digits-only text) — null or
   * "0" means a free tournament. Written once at creation; the client can
   * never change a fee after the fact.
   */
  entryFeeLuna: string | null;
  /** Phase 2B: prize distribution preset for paid tournaments. */
  prizePreset: "winner" | "top3" | "top5" | null;
  /** Phase 2B: aggregate payout state (server-maintained; "none" until paid out). */
  payoutStatus: "none" | "pending" | "partial" | "paid" | "refund_required" | "refunded";
  /** Durable refund obligations for a cancelled paid event, keyed per player. */
  refunds?: Record<string, RefundRecord>;
}

/**
 * One refund obligation from a cancelled paid tournament. Durable, part of
 * the tournament document (mirrored to Supabase): keyed per player so a
 * retry can never create a second refund row. Status:
 *   owed → dispatched → verified (or failed → owed again on retry-safe failure)
 */
export interface RefundRecord {
  playerId: string;
  /** The verified entry tx this refund returns. */
  entryTxHash: string;
  /** Exact luna to return (always exactly what was paid). */
  amountLuna: string;
  /** "owed" until a refund tx exists; "dispatched" once broadcast; verified after confirmation. */
  status: "owed" | "dispatched" | "verified" | "failed";
  /** Real outgoing refund tx hash (set on dispatch). */
  refundTxHash: string | null;
  /** Winner-write-ahead datum for the refund broadcast (crash recovery). */
  validityStartHeight?: number | null;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  verifiedAt: number | null;
}

export function tournamentKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/* ------------------------------------------------------------------ */
/* Per-document mutation lock                                          */
/* ------------------------------------------------------------------ */

/**
 * One promise chain per tournament id. Every mutation runs inside
 * `withTournamentLock(id, fn)`, so a read-modify-write cycle can never
 * interleave with another write to the SAME tournament — the exact race that
 * let six concurrent joins all read 0 entries and all pass the cap.
 *
 * Cross-process, the durable mirror's conditional status updates still guard
 * the lifecycle transitions; this lock is what makes the in-process path
 * correct (and the file-store/KV path correct outright).
 */
const locks = new Map<string, Promise<unknown>>();

export async function withTournamentLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Store a chain that never rejects, or one failed mutation would poison
  // every later one for this tournament.
  locks.set(
    id,
    run.catch(() => undefined),
  );
  return run;
}

export function newTournamentId(): string {
  return `tour_${randomHex(8)}`;
}

export function newMatchId(): string {
  return `tm_${randomHex(8)}`;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function parseDoc(raw: string | null): TournamentDocument | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TournamentDocument;
  } catch {
    return null;
  }
}

export async function getTournamentDoc(id: string): Promise<TournamentDocument | null> {
  return parseDoc(await getGameStorage().get(tournamentKey(id)));
}

/** Every tournaments' index entry (fast store only; Supabase is the rebuild source). */
export interface TournamentIndexEntry {
  id: string;
  name: string;
  format: TournamentFormat;
  status: TournamentStatus;
  playerCount: number;
  maxPlayers: number;
  creatorId: string;
  createdAt: number;
  scheduledStartAt?: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /** Phase 2B economy fields (additive). */
  entryFeeLuna?: string | null;
  prizePreset?: "winner" | "top3" | "top5" | null;
  payoutStatus?: "none" | "pending" | "partial" | "paid" | "refund_required" | "refunded";
  /** Lifecycle: lock + start the moment the field fills (host's choice). */
  startWhenFull?: boolean;
}

async function readIndex(): Promise<TournamentIndexEntry[]> {
  const raw = await getGameStorage().get(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TournamentIndexEntry[];
  } catch {
    return [];
  }
}

async function writeIndex(entries: TournamentIndexEntry[]): Promise<void> {
  await getGameStorage().set(INDEX_KEY, JSON.stringify(entries.slice(0, INDEX_MAX)));
}

/**
 * The index is ONE persisted value read-modify-written by every tournament
 * mutation (write, delete). Concurrent writes — a full field joining at
 * once — would each read the list, splice their entry, and write the whole
 * list back, clobbering each other's update. One chain serializes every
 * index RMW, exactly like the per-tournament document lock below.
 */
let indexChain: Promise<unknown> = Promise.resolve();
async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexChain.then(fn, fn);
  indexChain = run.catch(() => undefined);
  return run;
}

export async function upsertTournamentIndexEntry(doc: TournamentDocument): Promise<void> {
  await withIndexLock(async () => {
    const entries = await readIndex();
    const entry: TournamentIndexEntry = {
      id: doc.id,
      name: doc.name,
      format: doc.format,
      status: doc.status,
      playerCount: doc.entries.length,
      maxPlayers: doc.maxPlayers,
      creatorId: doc.creatorId,
      createdAt: doc.createdAt,
      scheduledStartAt: doc.scheduledStartAt,
      startedAt: doc.startedAt,
      completedAt: doc.completedAt,
    };
    // Phase 2B economy fields ride along in the index entry (extra fields are
    // additive and harmless to older readers).
    entry.entryFeeLuna = doc.entryFeeLuna ?? null;
    entry.prizePreset = doc.prizePreset ?? null;
    entry.payoutStatus = doc.payoutStatus ?? "none";
    entry.startWhenFull = doc.startWhenFull ?? false;
    const idx = entries.findIndex((e) => e.id === doc.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.unshift(entry);
    await writeIndex(entries);
  });
}

/**
 * List tournaments, newest first, optionally filtered by status.
 * Falls back to Supabase when the fast index is cold (fresh instance).
 */
export async function listTournamentDocs(opts?: {
  status?: TournamentStatus;
  creatorId?: string;
  limit?: number;
}): Promise<TournamentDocument[]> {
  let entries = await readIndex();
  if (entries.length === 0 && supabaseConfigured()) {
    // Cold fast store: rebuild from the durable mirror.
    const docs = await listTournamentRowsFromSupabase();
    for (const doc of docs) await upsertTournamentIndexEntry(doc);
    entries = await readIndex();
  }
  let filtered = entries;
  if (opts?.status) filtered = filtered.filter((e) => e.status === opts.status);
  if (opts?.creatorId) filtered = filtered.filter((e) => e.creatorId === opts.creatorId);
  const limit = opts?.limit ?? 50;
  const docs: TournamentDocument[] = [];
  for (const e of filtered.slice(0, limit)) {
    const doc = await getTournamentDoc(e.id);
    if (doc) docs.push(doc);
  }
  return docs;
}

/* ------------------------------------------------------------------ */
/* Refund ledger                                                       */
/* ------------------------------------------------------------------ */

/**
 * The refund ledger rides the tournament document (one source of truth, the
 * same lock, the same mirror) and is keyed per player — a retried refund
 * rewrites its own row instead of adding one.
 */
export async function getRefunds(id: string): Promise<RefundRecord[]> {
  const doc = await getTournamentDoc(id);
  return doc?.refunds ? Object.values(doc.refunds) : [];
}

export async function upsertRefund(id: string, refund: RefundRecord): Promise<void> {
  await withTournamentLock(id, async () => {
    const doc = await getTournamentDoc(id);
    if (!doc) return;
    doc.refunds = doc.refunds ?? {};
    doc.refunds[refund.playerId] = refund;
    await writeTournamentDoc(doc);
  });
  await mirrorRefund(id, refund);
}

export async function mirrorRefund(tournamentId: string, refund: RefundRecord): Promise<void> {
  if (!supabaseConfigured()) return;
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return;
    const { error } = await admin.from("tournament_refunds").upsert(
      {
        tournament_id: tournamentId,
        player_id: refund.playerId,
        entry_tx_hash: refund.entryTxHash,
        amount_luna: refund.amountLuna,
        status: refund.status,
        refund_tx_hash: refund.refundTxHash,
        validity_start_height: refund.validityStartHeight ?? null,
        attempts: refund.attempts,
        last_error: refund.lastError,
        created_at: new Date(refund.createdAt).toISOString(),
        verified_at: refund.verifiedAt ? new Date(refund.verifiedAt).toISOString() : null,
      },
      { onConflict: "tournament_id,player_id" },
    );
    if (error) {
      console.warn(`[chainmate] refund mirror failed (${tournamentId}):`, error.message);
    }
  } catch {
    // Mirror is best-effort by design.
  }
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Persist the whole document and refresh its index entry. Callers have
 * already validated the transition — this function trusts its input (the
 * validation lives in lib/server/tournaments.ts, where it can see the doc).
 */
export async function writeTournamentDoc(doc: TournamentDocument): Promise<void> {
  await getGameStorage().set(tournamentKey(doc.id), JSON.stringify(doc));
  await upsertTournamentIndexEntry(doc);
  // Durability mirror — best-effort, exactly like upsertGameSnapshot. A
  // Supabase hiccup never breaks a tournament action; the fast store stays
  // the source of truth and the mirror is the cold-start recovery path.
  if (supabaseConfigured()) {
    try {
      await upsertTournamentRow(doc);
      await upsertEntryRows(doc);
      await upsertMatchRows(doc);
      await writeStandingsRow(doc);
    } catch {
      // Mirror is best-effort by design.
    }
  }
}

/**
 * Remove a tournament everywhere: the fast document, its index entry, and
 * the durable Supabase mirror row (entries/matches/standings cascade or are
 * ignored — the row is the recovery root, so deleting it removes the event
 * from every list on the next cold start). Used by the host's Delete action
 * for drafts/registrations that never started.
 */
export async function deleteTournamentDoc(id: string): Promise<void> {
  await getGameStorage().delete(tournamentKey(id));
  await withIndexLock(async () => {
    const entries = (await readIndex()).filter((e) => e.id !== id);
    await writeIndex(entries);
  });
  if (supabaseConfigured()) {
    try {
      const admin = getSupabaseAdmin();
      if (admin) await admin.from("tournaments").delete().eq("id", id);
    } catch {
      // Mirror is best-effort by design — the fast store stays authoritative.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Supabase mirror                                                     */
/* ------------------------------------------------------------------ */

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

/**
 * One row per tournament. `entry_fee_nim` is a NULLABLE RESERVED column for
 * Phase 2B — this phase never writes it (it stays NULL for every row).
 */
async function upsertTournamentRow(doc: TournamentDocument): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin.from("tournaments").upsert(
    {
      id: doc.id,
      name: doc.name,
      description: doc.description,
      creator_player_id: doc.creatorId,
      format: doc.format,
      time_control: doc.timeControl,
      max_players: doc.maxPlayers,
      status: doc.status,
      swiss_rounds: doc.swissRounds,
      registration_closes_at: iso(doc.registrationClosesAt),
      scheduled_start_at: iso(doc.scheduledStartAt),
      scheduled_end_at: iso(doc.scheduledEndAt),
      cancel_reason: doc.cancelReason ?? null,
      min_players: doc.minPlayers ?? null,
      start_when_full: doc.startWhenFull ?? false,
      started_at: iso(doc.startedAt),
      completed_at: iso(doc.completedAt),
      current_round: doc.currentRound,
      total_rounds: doc.totalRounds,
      winner_player_id: doc.winnerId,
      // Phase 2B economy: exact luna text + preset + payout aggregate.
      entry_fee_luna: doc.entryFeeLuna ?? null,
      prize_preset: doc.prizePreset ?? null,
      payout_status: doc.payoutStatus ?? "none",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) {
    console.warn(`[chainmate] tournament mirror failed (${doc.id}):`, error.message);
  }
}

async function upsertEntryRows(doc: TournamentDocument): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const rows = doc.entries.map((e) => ({
    tournament_id: doc.id,
    player_id: e.playerId,
    joined_at: iso(e.joinedAt),
    left_at: iso(e.leftAt ?? null),
    withdrawn: e.leftAt !== undefined,
  }));
  if (rows.length === 0) return;
  const { error } = await admin
    .from("tournament_entries")
    .upsert(rows, { onConflict: "tournament_id,player_id" });
  if (error) {
    console.warn(`[chainmate] tournament entries mirror failed (${doc.id}):`, error.message);
  }
}

async function upsertMatchRows(doc: TournamentDocument): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const rows = doc.matches.map((m) => ({
    id: m.id,
    tournament_id: doc.id,
    round: m.round,
    slot: m.slot,
    white_player_id: m.whitePlayerId,
    black_player_id: m.blackPlayerId,
    game_id: m.gameId,
    status: m.status,
    result: m.result ?? null,
    result_reason: m.resultReason ?? null,
    created_at: iso(m.createdAt),
    completed_at: iso(m.completedAt ?? null),
  }));
  if (rows.length === 0) return;
  const { error } = await admin.from("tournament_matches").upsert(rows, { onConflict: "id" });
  if (error) {
    console.warn(`[chainmate] tournament matches mirror failed (${doc.id}):`, error.message);
  }
}

async function writeStandingsRow(doc: TournamentDocument): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("tournament_standings")
    .upsert(
      {
        tournament_id: doc.id,
        standings: JSON.stringify(doc.standings),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tournament_id" },
    );
  if (error) {
    console.warn(`[chainmate] tournament standings mirror failed (${doc.id}):`, error.message);
  }
}

/**
 * Cold-start recovery: rebuild the index from the durable mirror. Only reads
 * the columns the index entry needs — full documents come back through the
 * fast store, which is the source of truth.
 */
async function listTournamentRowsFromSupabase(): Promise<TournamentDocument[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("tournaments")
    .select("id, name, description, creator_player_id, format, time_control, max_players, status, swiss_rounds, created_at, registration_closes_at, scheduled_start_at, scheduled_end_at, cancel_reason, min_players, start_when_full, started_at, completed_at, current_round, total_rounds, winner_player_id, entry_fee_luna, prize_preset, payout_status")
    .order("created_at", { ascending: false })
    .limit(INDEX_MAX);
  if (error || !data) return [];
  return (data as unknown as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    creatorId: String(row.creator_player_id),
    format: (TOURNAMENT_FORMATS as string[]).includes(String(row.format))
      ? (row.format as TournamentFormat)
      : "swiss",
    timeControl: String(row.time_control ?? ""),
    maxPlayers: Number(row.max_players ?? 0),
    status: String(row.status) as TournamentStatus,
    swissRounds: row.swiss_rounds === null ? null : Number(row.swiss_rounds),
    createdAt: row.created_at ? new Date(String(row.created_at)).getTime() : Date.now(),
    registrationClosesAt: row.registration_closes_at
      ? new Date(String(row.registration_closes_at)).getTime()
      : null,
    scheduledStartAt: row.scheduled_start_at
      ? new Date(String(row.scheduled_start_at)).getTime()
      : null,
    scheduledEndAt: row.scheduled_end_at
      ? new Date(String(row.scheduled_end_at)).getTime()
      : null,
    cancelReason: row.cancel_reason ? String(row.cancel_reason) : null,
    minPlayers: row.min_players === null || row.min_players === undefined ? null : Number(row.min_players),
    startWhenFull: row.start_when_full === true,
    startedAt: row.started_at ? new Date(String(row.started_at)).getTime() : null,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).getTime() : null,
    currentRound: Number(row.current_round ?? 0),
    totalRounds: Number(row.total_rounds ?? 0),
    winnerId: row.winner_player_id ? String(row.winner_player_id) : null,
    entries: [],
    matches: [],
    standings: [],
    entryFeeLuna: row.entry_fee_luna ? String(row.entry_fee_luna) : null,
    prizePreset:
      row.prize_preset === "winner" || row.prize_preset === "top3" || row.prize_preset === "top5"
        ? row.prize_preset
        : null,
    payoutStatus:
      row.payout_status === "pending" ||
      row.payout_status === "partial" ||
      row.payout_status === "paid" ||
      row.payout_status === "refund_required" ||
      row.payout_status === "refunded"
        ? row.payout_status
        : "none",
  }));
}

/* ------------------------------------------------------------------ */
/* gameId → tournamentId map (result ingestion lookup)                 */
/* ------------------------------------------------------------------ */

const GAME_MAP_PREFIX = "chainmate:tournament:game:";

/**
 * Remember which tournament a tournament game belongs to, so the end-of-game
 * hook can find the match in O(1) instead of scanning every running
 * tournament. One small record per tournament game; the write happens on the
 * same document write that creates the match.
 */
export async function recordTournamentGame(gameId: string, tournamentId: string): Promise<void> {
  await getGameStorage().set(
    `${GAME_MAP_PREFIX}${gameId}`,
    JSON.stringify({ tournamentId, at: Date.now() }),
  );
}

/** The tournament holding a match on this game, or null for ordinary games. */
export async function tournamentIdForGame(gameId: string): Promise<string | null> {
  if (!gameId) return null;
  const raw = await getGameStorage().get(`${GAME_MAP_PREFIX}${gameId}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as { tournamentId?: string };
    return rec.tournamentId ?? null;
  } catch {
    return null;
  }
}

/** Conditional status update — the cross-instance lock for status transitions. */
export async function transitionTournamentStatus(
  id: string,
  from: TournamentStatus,
  to: TournamentStatus,
): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return true; // no durable lock available — in-process check stands
  const { data, error } = await admin
    .from("tournaments")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", from)
    .select("id");
  if (error) {
    // Durable lock unavailable — fall back to the in-process transition check
    // rather than failing the action (same philosophy as hosted.ts).
    console.warn("[chainmate] tournament status lock unavailable:", error.message);
    return true;
  }
  return Array.isArray(data) && data.length > 0;
}

export type { TournamentSummary };

/* ------------------------------------------------------------------ */
/* Durable full-field cross-check (cross-instance join race)           */
/* ------------------------------------------------------------------ */

/**
 * Cross-instance cap check against the durable mirror. The fast store is
 * the source of truth for a tournament document, but a COLD instance (or
 * one whose KV read raced a concurrent join's write) can read a stale entry
 * list and admit one player too many. The mirrored rows are written
 * synchronously inside every join's document write, so by the time a
 * genuinely concurrent join on another instance lands, the durable count
 * already reflects the earlier join.
 *
 * Returns FALSE (authoritative "full") only when the durable mirror is
 * configured AND shows at least `maxPlayers` active rows — the one case the
 * in-process lock cannot see. NULL means "no durable answer" (unconfigured,
 * or a transient error): the caller falls back to the fast-store check
 * rather than failing a legitimate join on a database hiccup.
 */
export async function durableJoinFieldCount(
  tournamentId: string,
): Promise<number | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  try {
    const { count, error } = await admin
      .from("tournament_entries")
      .select("player_id", { count: "exact", head: true })
      .eq("tournament_id", tournamentId)
      .eq("withdrawn", false);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}
