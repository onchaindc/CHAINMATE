// Server-only module — never import from client components.

import {
  SWISS_BYE_OPPONENT,
  SWISS_DEFAULT_ROUNDS,
  SWISS_MAX_ROUNDS,
  isTournamentTerminal,
  knockoutRoundCount,
  type StandingRow,
  type TournamentEntry,
  type TournamentFormat,
  type TournamentMatch,
  type TournamentPayoutLine,
  type TournamentRound,
  type TournamentStatus,
  type TournamentSummary,
} from "@/lib/tournament-types";
import {
  computeKnockoutStandings,
  computeStandings,
  roundLabel,
} from "@/lib/tournament-standings";
import {
  deleteTournamentDoc,
  getTournamentDoc,
  listTournamentDocs,
  newMatchId,
  newTournamentId,
  recordTournamentGame,
  transitionTournamentStatus,
  withTournamentLock,
  writeTournamentDoc,
  type TournamentDocument,
} from "@/lib/server/tournament-store";
import { isPaidTournamentDoc, markEntryPaid as markEntryPaidOnDoc } from "@/lib/server/tournament-economy-doc";
import { listPaidEntries } from "@/lib/server/tournament-economy";
import type { TournamentRefundLine } from "@/lib/tournament-types";
import { isPaidEntryFee, lunaFromStored, presetRankCount, validateEntryFee } from "@/lib/tournament-economy";
import { getHostedGame, writeGame } from "@/lib/server/hosted";
import { isGameOver, type GameStatus, type GameState } from "@/lib/types";
import {
  requireNotBanned,
  isAdminPlayer,
} from "@/lib/server/admin";
import { getLinkedWallet } from "@/lib/server/nimiq/service";
import { getAccountByAddress } from "@/lib/server/nimiq/rpc";
import { NIMIQ_NETWORK } from "@/lib/nimiq/config";
import { formatNim, LUNA_PER_NIM, NimiqMoneyError } from "@/lib/nimiq/format";

/**
 * The tournament engine — server-authoritative, ChainMate Phase 2A.
 *
 * Everything mutating lives here and is only reachable from the API routes,
 * which authenticate through resolveActingPlayer(). The client can read
 * anything and suggest nothing: there is no endpoint that accepts a result,
 * a winner, or a rank.
 *
 * Chess integration: every match carries a gameId into an existing hosted
 * ChainMate game. Results are ingested from the game itself — the end-of-game
 * paths in lib/server/hosted.ts call ingestTournamentGameResult() after the
 * authoritative game state is persisted — and this module re-reads the game
 * when asked, so a tournament never stores a result the game disagrees with.
 *
 * Concurrency: all mutations go read-doc → validate → write-doc under the
 * storage layer's per-process serialisation, plus durable conditional status
 * locks (transitionTournamentStatus) for the transitions two instances could
 * race on (start, complete). Result ingestion is idempotent per match: a
 * completed match is skipped on re-ingest (see ingestTournamentGameResult).
 */

/* ------------------------------------------------------------------ */
/* Validation (creation)                                               */
/* ------------------------------------------------------------------ */

/** Time controls the game system itself offers ("10 + 0" style). */
const TIME_CONTROL_RE = /^\s*(?:[1-9]\d?|1\d{2}|180)\s*\+\s*(?:\d{1,2})\s*$/;

export interface CreateTournamentInput {
  name: string;
  description?: string;
  format: TournamentFormat;
  timeControl: string;
  maxPlayers: number;
  swissRounds?: number;
  registrationClosesAt?: number | null;
  /**
   * Scheduled start (Unix ms) — when the event should go live. While it is
   * in the future the tournament sits in DRAFT and opens registration
   * automatically at that instant; the host can always open it early.
   */
  scheduledStartAt?: number | null;
  /**
   * Arena: when the tournament window closes (Unix ms). When the instant
   * passes the event finalizes automatically — standings freeze, paid
   * events plan payouts, no host click required. Null = host-controlled.
   */
  scheduledEndAt?: number | null;
  /**
   * Lock + start the moment the field reaches maxPlayers (host's choice at
   * creation). Default false — the event waits for its scheduled start or
   * the host, matching the historical behaviour.
   */
  startWhenFull?: boolean;
  /** Phase 2B: exact entry fee in luna (omit or 0n for a free tournament). */
  entryFeeLuna?: bigint;
  /** Phase 2B: prize distribution preset — required for paid tournaments. */
  prizePreset?: "winner" | "top3" | "top5";
}

/** Returns the first validation error, or null when the input is acceptable. */
export function validateTournamentInput(
  input: CreateTournamentInput,
): string | null {
  const name = (input.name ?? "").trim();
  if (name.length < 2 || name.length > 60) {
    return "name required (2–60 chars)";
  }
  const description = (input.description ?? "").trim();
  if (description.length > 500) return "description too long (max 500 chars)";
  if (!isTournamentFormat(input.format)) {
    return "format must be knockout, swiss or arena";
  }
  if (!TIME_CONTROL_RE.test(input.timeControl ?? "")) {
    return "timeControl must look like '10 + 0'";
  }
  if (
    !Number.isInteger(input.maxPlayers) ||
    input.maxPlayers < 2 ||
    input.maxPlayers > 128
  ) {
    return "maxPlayers must be an integer 2–128";
  }
  if (input.format === "swiss") {
    const rounds = input.swissRounds ?? SWISS_DEFAULT_ROUNDS;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > SWISS_MAX_ROUNDS) {
      return "swiss rounds must be an integer 1–11";
    }
  }
  if (
    input.registrationClosesAt !== undefined &&
    input.registrationClosesAt !== null &&
    (!Number.isFinite(input.registrationClosesAt) ||
      (input.registrationClosesAt as number) < Date.now())
  ) {
    return "registration window invalid";
  }
  if (
    input.scheduledStartAt !== undefined &&
    input.scheduledStartAt !== null &&
    (!Number.isFinite(input.scheduledStartAt) ||
      (input.scheduledStartAt as number) < Date.now())
  ) {
    return "scheduled start must be in the future";
  }
  if (
    input.scheduledStartAt != null &&
    input.registrationClosesAt != null &&
    input.registrationClosesAt > input.scheduledStartAt
  ) {
    return "registration must close before the scheduled start";
  }
  if (
    input.scheduledEndAt !== undefined &&
    input.scheduledEndAt !== null &&
    (!Number.isFinite(input.scheduledEndAt) || (input.scheduledEndAt as number) < Date.now())
  ) {
    return "scheduled end must be in the future";
  }
  // Phase 2B economy validation. entryFeeLuna arrives as an exact bigint
  // (already parsed from the human NIM string server-side); 0/absent = free.
  const fee = input.entryFeeLuna ?? 0n;
  if (fee < 0n) return "entryFeeNim must be greater than 0 for a paid tournament";
  if (fee > 0n) {
    const feeError = validateEntryFee(fee);
    if (feeError) return feeError;
    if (!input.prizePreset) {
      return "a paid tournament requires a prize distribution preset";
    }
    if (!isPrizePresetValue(input.prizePreset)) {
      return "prize distribution must be winner, top3 or top5";
    }
  }
  return null;
}

function isPrizePresetValue(v: unknown): v is "winner" | "top3" | "top5" {
  return v === "winner" || v === "top3" || v === "top5";
}

function isTournamentFormat(v: unknown): v is TournamentFormat {
  return v === "knockout" || v === "swiss" || v === "arena";
}

/* ------------------------------------------------------------------ */
/* Creation & lifecycle                                                */
/* ------------------------------------------------------------------ */


/**
 * Minimum LINKED-wallet holdings to HOST any tournament (free or paid).
 * Cheap enough to never block a genuine player; high enough that a
 * drive-by spammer burns 50 real NIM of wallet to flood the list.
 *
 * "Holdings" = the basic account PLUS every active wrapper contract
 * (HTLC/vesting) the wallet created — Nimiq Pay keeps user funds in such
 * wrappers and pays from them, so a basic-account-only read reports zero
 * for a funded wallet (the operator's 2453 NIM sat in an HTLC wrapper).
 */
export const CREATOR_MIN_NIM = 50;

/**
 * Settable test seam for the hosting gate's RPC/ban dependencies: tests
 * inject in-memory fakes so the engine suite keeps running with no Nimiq
 * node and no wallet bindings. Production code leaves this unset.
 */
interface CreationGateDeps {
  getLinkedWallet?: (playerId: string) => Promise<{ address: string; network: string } | null>;
  getAccountBalanceLuna?: (address: string) => Promise<bigint>;
}
let creationGateDeps: CreationGateDeps | null = null;

/** Test-only injection point for the creation gate's external reads. */
export function setTournamentCreationGateDeps(deps: CreationGateDeps | null): void {
  creationGateDeps = deps;
}

async function gateTournamentCreation(creatorId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ban = await requireNotBanned(creatorId);
  if (!ban.ok) return { ok: false, error: ban.error! };

  const linked = creationGateDeps?.getLinkedWallet
    ? await creationGateDeps.getLinkedWallet(creatorId).catch(() => null)
    : await getLinkedWallet(creatorId).catch(() => null);
  if (!linked) {
    return {
      ok: false,
      error: `Link your Nimiq wallet to host a tournament: hosting requires a wallet holding at least ${CREATOR_MIN_NIM} NIM`,
    };
  }
  if (linked.network !== NIMIQ_NETWORK) {
    return {
      ok: false,
      error: `Your wallet is linked on the ${linked.network} network but this deployment runs on ${NIMIQ_NETWORK}: relink your wallet, then host.`,
    };
  }
  try {
    let balance: bigint;
    if (creationGateDeps?.getAccountBalanceLuna) {
      balance = await creationGateDeps.getAccountBalanceLuna(linked.address);
    } else {
      // TRUE holdings: basic account + wallet-created wrapper contracts
      // (Nimiq Pay sweeps balances into HTLC/vesting wrappers it later pays
      // from — a basic-only read says zero for a funded wallet).
      const { getTotalHoldingsLuna } = await import("@/lib/server/nimiq/rpc");
      const holdings = await getTotalHoldingsLuna(linked.address, { timeoutMs: 10_000 });
      balance = holdings.totalLuna;
    }
    if (balance < BigInt(CREATOR_MIN_NIM) * LUNA_PER_NIM) {
      // Name the exact wallet that was checked and what it holds. The most
      // common failure is a linked wallet that differs from the funded one
      // (a second Nimiq Pay account); without the address and the number the
      // error reads as nonsense to a player looking at a funded wallet.
      return {
        ok: false,
        error:
          `Hosting requires at least ${CREATOR_MIN_NIM} NIM in your LINKED wallet ` +
          `(${linked.address}). That wallet currently holds ${formatNim(balance)} NIM. ` +
          `Your NIM may be in a different Nimiq Pay account: switch to the linked ` +
          `account and fund it, or use Replace wallet in your profile to link the ` +
          `funded one.`,
      };
    }
  } catch (err) {
    if (err instanceof NimiqMoneyError) {
      return { ok: false, error: "Your wallet reported an unreadable balance. Try again." };
    }
    return {
      ok: false,
      error: "The Nimiq node could not be reached to check your wallet balance. Try again in a moment.",
    };
  }
  return { ok: true };
}

export async function createTournament(
  creatorId: string,
  input: CreateTournamentInput,
): Promise<TournamentDocument> {
  const error = validateTournamentInput(input);
  if (error) throw new Error(error);

  // Hosting is a privilege, not a given: every creator must hold at least
  // CREATOR_MIN_NIM NIM in their LINKED wallet (free and paid events alike).
  // Banned players are shut out too. Both checks run before the doc exists,
  // so there is never an orphaned tournament to clean up.
  const gate = await gateTournamentCreation(creatorId);
  if (!gate.ok) throw new Error(gate.error);

  const now = Date.now();
  // Minimum field: max(2, advertised prize positions). The preset's rank
  // count is what the UI advertises as paid places, so an event that starts
  // below this could never pay its advertised structure — better to cancel
  // and refund at the deadline than to silently shortchange a rank.
  const presetRankCountOf = input.prizePreset ?? null;
  const minPlayers =
    input.entryFeeLuna !== undefined && input.entryFeeLuna > 0n && presetRankCountOf
      ? Math.max(2, presetRankCount(presetRankCountOf))
      : 2;
  const doc: TournamentDocument = {
    id: newTournamentId(),
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    creatorId,
    format: input.format,
    timeControl: input.timeControl,
    maxPlayers: input.maxPlayers,
    // A tournament is born in DRAFT; the host opens registration explicitly.
    status: "draft",
    swissRounds: input.format === "swiss" ? input.swissRounds ?? SWISS_DEFAULT_ROUNDS : null,
    createdAt: now,
    registrationClosesAt: input.registrationClosesAt ?? null,
    scheduledStartAt: input.scheduledStartAt ?? null,
    scheduledEndAt: input.scheduledEndAt ?? null,
    minPlayers,
    startWhenFull: input.startWhenFull ?? false,
    cancelReason: null,
    startedAt: null,
    completedAt: null,
    nextRoundAt: null,
    currentRound: 0,
    totalRounds: 0,
    winnerId: null,
    entries: [],
    matches: [],
    standings: [],
    // Phase 2B economy: exact luna string or null (free tournament).
    entryFeeLuna:
      input.entryFeeLuna !== undefined && input.entryFeeLuna > 0n
        ? input.entryFeeLuna.toString()
        : null,
    prizePreset: input.entryFeeLuna !== undefined && input.entryFeeLuna > 0n ? input.prizePreset ?? null : null,
    payoutStatus: "none",
  };
  await writeTournamentDoc(doc);
  return doc;
}

export type TransitionResult =
  | { ok: true; doc: TournamentDocument }
  | { ok: false; error: string };

const LEGAL: Record<TournamentStatus, TournamentStatus[]> = {
  draft: ["registration", "cancelled"],
  // REGISTRATION may go straight to IN_PROGRESS: a 2-player casual event
  // needs no separate lock step (LOCKED exists for the host who wants one).
  registration: ["locked", "in_progress", "cancelled"],
  // LOCKED may reopen registration (host got cold feet before any play).
  locked: ["in_progress", "registration", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/**
 * Move a tournament one legal step along its lifecycle. The durable lock is
 * taken first (conditional UPDATE on status), so two hosts hammering "start"
 * on different instances produce exactly one IN_PROGRESS; the in-process
 * document lock serialises read-validate-write against joins and results.
 */
/**
 * HOST FINALIZE — terminate every unfinished match's live game.
 *
 * For each non-complete match with a real gameId, the underlying hosted game
 * is force-ended in the game store (status "resigned", no winner attributed
 * beyond the board position — the MATCH itself is voided, not decided). Both
 * players' game pages poll the store, so the board ends for them within one
 * poll of the host clicking "End & finalise" — no phantom "live" rounds, no
 * "Resume game" into a dead event. Ingestion is NOT triggered: a finalized
 * tournament must not re-enter the round machine. Failures are per-game
 * best-effort: one broken store write must not stop the sweep.
 */
async function voidLiveMatchesOnCompletion(doc: TournamentDocument): Promise<void> {
  const unfinished = doc.matches.filter((m) => m.status !== "complete" && m.gameId);
  if (unfinished.length === 0) return;
  const now = Date.now();
  for (const match of unfinished) {
    try {
      const game = await getHostedGame(match.gameId);
      if (game && !isGameOver(game.status)) {
        await writeGame({
          ...game,
          status: "resigned",
          winner: "",
          endedAt: now,
          updatedAt: now,
          summary: game.summary || "Tournament finalized by the host — the game was closed without a result.",
        });
      }
    } catch {
      // best-effort: the match is voided below regardless
    }
    match.status = "complete";
    match.resultReason = "aborted"; // voided: no standings impact, no payout effect
    match.completedAt = now;
  }
}

export async function transitionTournament(
  tournamentId: string,
  actorId: string,
  to: TournamentStatus,
  cancelReason?: string,
): Promise<TransitionResult> {
  return withTournamentLock(tournamentId, () =>
    transitionTournamentInner(tournamentId, actorId, to, cancelReason),
  );
}

async function transitionTournamentInner(
  tournamentId: string,
  actorId: string,
  to: TournamentStatus,
  cancelReason?: string,
): Promise<TransitionResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  if (doc.creatorId !== actorId) {
    return { ok: false, error: "Only the host can change the tournament" };
  }
  if (!LEGAL[doc.status].includes(to)) {
    return { ok: false, error: `Cannot move from ${doc.status} to ${to}` };
  }

  // Side effects that must happen under the transition itself.
  if (to === "in_progress") {
    // One code path for every start (host action, startWhenFull, scheduled
    // start): the same wedge-heal, entry-payment gate and round generation.
    // transitionTournament only ever arrives from the HOST (the actor check
    // above), so this door may refuse on unpaid entries; the time-driven
    // callers below pass "authority" and drop them instead.
    return startTournamentNow(doc, "host");
  }

  if (to === "completed") {
    const won = await transitionTournamentStatus(doc.id, doc.status, "completed");
    if (!won) return { ok: false, error: "The tournament was already completed elsewhere" };
    doc.status = "completed";
    doc.completedAt = Date.now();
    await writeTournamentDoc(doc);
    // HOST FINALIZE TERMINATES EVERY LIVE GAME — immediately, before anything
    // else. The old order completed the tournament first and left the round
    // games running in the game store, so the page kept showing "live" and
    // "Resume game" for rounds that no longer existed. Unfinished matches are
    // voided (aborted — no standings impact), each live game is terminated in
    // the real game store, and BOTH players' clients see the game end on
    // their next poll.
    await voidLiveMatchesOnCompletion(doc);
    // Same completion body as the engine's own path (below): trophies and
    // the payout plan. completeTournamentInner is the single door for engine
    // completions; this one serves the host clicking Complete.
    doc.winnerId = null;
    const standings = recomputeStandings(doc);
    const top = standings.find((x) => x.played > 0 || x.points > 0);
    doc.winnerId = top?.playerId ?? null;
    doc.standings = standings;
    await writeTournamentDoc(doc);
    await awardTournamentTrophies(doc).catch(() => undefined);
    await planPayoutsIfPaid(doc).catch(() => undefined);
    return { ok: true, doc };
  }

  if (to === "cancelled") {
    const won = await transitionTournamentStatus(doc.id, doc.status, "cancelled");
    if (!won) return { ok: false, error: "The tournament was already closed elsewhere" };
    doc.status = "cancelled";
    // Reason of record: the deadline-miss path names its exact cause; a host
    // cancellation records the host's own words. Empty → generic.
    doc.cancelReason = cancelReason ?? null;
    // Phase 2B: cancelling a PAID tournament that has verified entries
    // materialises one durable refund obligation per verified entrant —
    // status 'owed' in the refund ledger, aggregated as refund_required.
    // Dispatch is an operations concern; nothing here pretends money moved.
    if (isPaidTournamentDoc(doc)) {
      try {
        const paid = await listPaidEntries(doc.id);
        if (paid.length > 0) {
          await materializeRefunds(doc, paid);
          doc.payoutStatus = "refund_required";
        }
      } catch {
        // Ledger unavailable: flag refund_required defensively.
        doc.payoutStatus = "refund_required";
      }
    }
    await writeTournamentDoc(doc);
    return { ok: true, doc };
  }

  // registration / locked — no durable lock needed beyond the re-check above.
  doc.status = to;
  await writeTournamentDoc(doc);
  return { ok: true, doc };
}

function totalRoundsFor(doc: TournamentDocument, playerCount: number): number {
  if (doc.format === "knockout") return knockoutRoundCount(playerCount);
  if (doc.format === "swiss") return doc.swissRounds ?? SWISS_DEFAULT_ROUNDS;
  return 0; // arena has no rounds
}

/**
 * Intermission between rounds (Swiss / knockout): after a round's LAST game
 * ends, the next round is scheduled this many milliseconds later rather than
 * dealt instantly. Players get a breather, the tournament page shows a
 * round-ended banner with a countdown, and nobody finds a fresh board dealt
 * while they were reading the result. The NEXT round's clock does not start
 * until both players arrive anyway (see arriveHostedGame) — the two
 * mechanisms compound instead of stacking waits.
 *
 * Overridable via TOURNAMENT_ROUND_INTERMISSION_MS (ms) — tests run with 0
 * so progression stays synchronous under `bun test`.
 */
export const ROUND_INTERMISSION_MS = parseIntermissionMs();

function parseIntermissionMs(): number {
  const raw = process.env.TOURNAMENT_ROUND_INTERMISSION_MS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 60_000;
}

/* ------------------------------------------------------------------ */
/* Maintenance — the idempotent time-driven state machine              */
/* ------------------------------------------------------------------ */

/** Exact entry fee for a paid tournament (0 luna when free). */
function entryFeeLunaOf(doc: TournamentDocument): bigint {
  return doc.entryFeeLuna ? lunaFromStored(doc.entryFeeLuna) : 0n;
}

/**
 * Materialise the payout records for a completed PAID tournament from the
 * verified ledger + final standings. Runs on EVERY completion path (host
 * action and engine progression alike), so no finished event is ever left
 * without its purse. Best-effort: completion stands even if planning fails
 * (maintenance re-runs it — planTournamentPayouts is idempotent). The doc
 * passed in is fresh and already persisted as completed; payoutStatus is
 * written back when rows are created.
 */
async function planPayoutsIfPaid(doc: TournamentDocument): Promise<void> {
  if (!isPaidTournamentDoc(doc) || !doc.prizePreset) return;
  const { planTournamentPayouts } = await import("@/lib/server/tournament-payouts");
  const { getVerifiedPrizePool } = await import("@/lib/server/tournament-economy");
  const standings = recomputeStandings(doc);
  const result = await planTournamentPayouts(
    doc.id,
    {
      preset: doc.prizePreset,
      standingsRanks: standings
        .filter((r) => r.rank <= 5)
        .map((r) => ({ rank: r.rank, playerId: r.playerId })),
    },
    {
      getPrizePool: (id) => getVerifiedPrizePool(id),
      getWallet: async (playerId) => {
        // Paid tournaments are account-gated in practice, but read the
        // binding defensively: no wallet → durable blocked state.
        const { getLinkedWallet } = await import("@/lib/server/nimiq/service");
        return getLinkedWallet(playerId);
      },
    },
  );
  if ("created" in result && result.created > 0 && doc.payoutStatus !== "refund_required" && doc.payoutStatus !== "refunded") {
    doc.payoutStatus = "pending";
    await writeTournamentDoc(doc);
  }
}

/**
 * Materialise one durable refund obligation per verified paid entrant of a
 * cancelled tournament. Writes the refund records INTO the document (the
 * caller holds the lock and persists it), then mirrors each row to Supabase
 * where schema-level uniqueness (0012) makes a duplicate refund impossible
 * even across instances. Status starts at 'owed': dispatch is an operations
 * concern and this phase never pretends money moved.
 */
async function materializeRefunds(
  doc: TournamentDocument,
  paid: Array<{ playerId: string; txHash: string; amountLuna: bigint }>,
): Promise<void> {
  doc.refunds = doc.refunds ?? {};
  const now = Date.now();
  for (const p of paid) {
    const existing = doc.refunds[p.playerId];
    if (existing) continue; // idempotent: one obligation per player, ever
    doc.refunds[p.playerId] = {
      playerId: p.playerId,
      entryTxHash: p.txHash,
      amountLuna: p.amountLuna.toString(),
      status: "owed",
      refundTxHash: null,
      attempts: 0,
      lastError: null,
      createdAt: now,
      verifiedAt: null,
    };
  }
  // Mirror after the caller persists the document, so the mirror can never
  // outpace the fast store.
  const { mirrorRefund } = await import("@/lib/server/tournament-store");
  for (const p of paid) {
    const record = doc.refunds[p.playerId];
    if (record) await mirrorRefund(doc.id, record).catch(() => undefined);
  }
}

/**
 * Start a locked/registration tournament RIGHT NOW (lock already held, doc
 * fresh). Shared by the host transition, the startWhenFull auto-start, and
 * the scheduled-start maintenance sweep — one code path, one set of checks.
 */
async function startTournamentNow(
  doc: TournamentDocument,
  source: "host" | "authority" = "host",
): Promise<TransitionResult> {
  // The mirror may already say in_progress while the live document never
  // got there: the durable status UPDATE commits BEFORE the fast-store
  // document is written, so a crash (or a cold function instance losing the
  // race mid-write) between the two steps left a "half-started" event. Every
  // later Start retry then hit "already started elsewhere" and no fixtures
  // were ever generated. Recognise that wedge and heal it instead of
  // failing: reconcile the mirror back to the live status, then proceed.
  if (doc.status !== "in_progress") {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const admin = getSupabaseAdmin();
    if (admin) {
      const { data: mirrorRow } = await admin
        .from("tournaments")
        .select("status")
        .eq("id", doc.id)
        .maybeSingle();
      if (mirrorRow?.status === "in_progress") {
        const healed = await transitionTournamentStatus(doc.id, "in_progress", doc.status);
        if (!healed) {
          // Another instance is starting it right now — report the race honestly.
          return { ok: false, error: "The tournament was already started elsewhere" };
        }
      }
    }
  }
  if (activeEntryCount(doc) < 2) {
    return { ok: false, error: "Need at least 2 players to start" };
  }
  // Phase 2B: a PAID tournament cannot start with unpaid entries. When the
  // start is AUTHORITY-DRIVEN (deadline passed / scheduled start / field
  // filled), waiting on a straggler would freeze the event forever: unpaid
  // entries are DROPPED instead — they were never confirmed, so nobody paid
  // anything to lose — and the event starts with the verified field. When
  // the start is HOST-driven (manual click), the host is told who is unpaid
  // so they can chase or drop them first: nothing silently deletes a seat
  // someone is actively trying to pay for.
  if (isPaidTournamentDoc(doc)) {
    const { listPaidEntries } = await import("@/lib/server/tournament-economy");
    const paidIds = new Set((await listPaidEntries(doc.id)).map((p) => p.playerId));
    const unpaid = doc.entries.filter(
      (e) => e.leftAt === undefined && !paidIds.has(e.playerId),
    );
    if (unpaid.length > 0) {
      if (source === "host") {
        const names = unpaid.map((e) => e.playerId.slice(0, 12)).join(", ");
        return {
          ok: false,
          error: `Cannot start yet — ${unpaid.length} entr${unpaid.length === 1 ? "y has" : "ies have"} not completed their entry payment (${names})`,
        };
      }
      for (const e of unpaid) e.leftAt = Date.now();
      await writeTournamentDoc(doc);
    }
  }
  const won = await transitionTournamentStatus(doc.id, doc.status, "in_progress");
  if (!won) return { ok: false, error: "The tournament was already started elsewhere" };

  doc.status = "in_progress";
  doc.startedAt = Date.now();
  doc.totalRounds = totalRoundsFor(doc, activeEntryCount(doc));
  doc.currentRound = 0;
  doc.nextRoundAt = null;
  doc.standings = recomputeStandings(doc);
  await writeTournamentDoc(doc);

  // First round generation is part of the start transition for formats
  // that need one (knockout always, swiss round 1). Arena pairs on demand.
  await ensureNextRoundInner(doc.id).catch(() => {});
  return { ok: true, doc };
}

/**
 * The field just reached maxPlayers (join path, lock held). Registration is
 * closed by the cap itself; the host's startWhenFull choice decides whether
 * "full" also means "playing now". Fully idempotent: a second call (a race,
 * or the maintenance sweep catching the same event) finds the tournament
 * already locked/started and does nothing.
 */
async function onFieldFilled(doc: TournamentDocument): Promise<void> {
  if (doc.status !== "registration") return;
  if (activeEntryCount(doc) < doc.maxPlayers) return;

  // Only the host's explicit startWhenFull choice turns a full field into
  // "playing now". The DEFAULT keeps the historical behaviour the schema
  // documents (0013_tournament_auto_start: "Default FALSE — the historical
  // behaviour is preserved"): the event stays in REGISTRATION with the cap
  // blocking further joins, until the host closes/starts it, the registration
  // deadline passes, or the scheduled start arrives. Auto-locking here broke
  // that contract — it also made leave-after-full impossible, since LEAVE is
  // a REGISTRATION-window action (a full event must be able to lose a player
  // and admit the next one).
  if (doc.startWhenFull !== true) return;

  // Lock + start in one sweep. The durable transition guards against a
  // concurrent instance doing the same; the loser re-reads and sees it done.
  const won = await transitionTournamentStatus(doc.id, "registration", "locked");
  if (!won) return; // someone else locked/started it
  doc.status = "locked";
  await writeTournamentDoc(doc);
  const fresh = await getTournamentDoc(doc.id);
  if (fresh && fresh.status === "locked") {
    await startTournamentNow(fresh, "authority").catch(() => undefined);
  }
}

/**
 * Deadline processing for one registration tournament whose window has
 * passed (lock held, doc fresh). THE underfilled rule:
 *
 *   active < minPlayers → CANCELLED (+ refunds for a paid event)
 *   otherwise           → LOCKED (field frozen, structure ready)
 *
 * minPlayers = max(2, advertised prize positions) for paid events — a Top-5
 * event can never start with 4 players and silently shortchange rank 5.
 */
async function processRegistrationDeadline(doc: TournamentDocument): Promise<void> {
  const active = activeEntryCount(doc);
  const min = doc.minPlayers ?? 2;
  const paid = isPaidTournamentDoc(doc);

  if (active < min) {
    const won = await transitionTournamentStatus(doc.id, doc.status, "cancelled");
    if (!won) return; // raced with a host action — their outcome wins
    doc.status = "cancelled";
    doc.cancelReason =
      `Not enough players joined before registration closed (${active}/${min} needed).` +
      (paid ? " Entry fees are being refunded." : "");
    if (paid) {
      try {
        const paidEntries = await listPaidEntries(doc.id);
        if (paidEntries.length > 0) {
          await materializeRefunds(doc, paidEntries);
          doc.payoutStatus = "refund_required";
        }
      } catch {
        doc.payoutStatus = "refund_required";
      }
    }
    await writeTournamentDoc(doc);
    return;
  }

  // Enough players: freeze the field. (For a startWhenFull event that never
  // filled, this is also the correct resting state: locked, waiting.)
  const won = await transitionTournamentStatus(doc.id, doc.status, "locked");
  if (!won) return;
  doc.status = "locked";
  await writeTournamentDoc(doc);
  // A scheduled start that has also passed starts the event immediately.
  if (doc.scheduledStartAt != null && Date.now() >= doc.scheduledStartAt) {
    const fresh = await getTournamentDoc(doc.id);
    if (fresh && fresh.status === "locked") {
      await startTournamentNow(fresh, "authority").catch(() => undefined);
    }
  }
}

/**
 * Auto-start for a locked tournament whose scheduled start has arrived
 * (lock held). Idempotent: startTournamentNow no-ops the second time.
 */
async function autoStartIfDue(doc: TournamentDocument): Promise<void> {
  if (doc.status !== "locked") return;
  if (doc.scheduledStartAt == null || Date.now() < doc.scheduledStartAt) return;
  const fresh = await getTournamentDoc(doc.id);
  if (fresh && fresh.status === "locked") {
    await startTournamentNow(fresh, "authority").catch(() => undefined);
  }
}

/**
 * Arena window close: stop new games, freeze standings, complete + plan
 * payouts. Idempotent (completeTournamentInner short-circuits on completed).
 */
async function finalizeArenaIfDue(doc: TournamentDocument): Promise<void> {
  if (doc.format !== "arena" || doc.status !== "in_progress") return;
  if (doc.scheduledEndAt == null || Date.now() < doc.scheduledEndAt) return;
  await completeTournamentInner(doc.id, null);
}

/**
 * The time-driven state machine — the engine's scheduler, run from every
 * tournament list/detail read (the app's poll cadence) and from the
 * maintenance API endpoint (a Vercel cron can hit it hourly). Every step is
 * idempotent and lock-guarded, so running it twice — or from two instances
 * at once — converges to the same state instead of duplicating work.
 */
export async function runTournamentMaintenance(): Promise<void> {
  let docs: TournamentDocument[];
  try {
    docs = await listTournamentDocs({ limit: 100 });
  } catch {
    return; // reads must never fail because of the scheduler
  }
  const now = Date.now();
  for (const doc of docs) {
    try {
      if (doc.status === "draft") {
        if (doc.scheduledStartAt != null && doc.scheduledStartAt <= now) {
          await withTournamentLock(doc.id, async () => {
            const fresh = await getTournamentDoc(doc.id);
            if (!fresh || fresh.status !== "draft") return;
            if (fresh.scheduledStartAt == null || fresh.scheduledStartAt > Date.now()) return;
            const won = await transitionTournamentStatus(fresh.id, fresh.status, "registration");
            if (!won) return;
            fresh.status = "registration";
            await writeTournamentDoc(fresh);
          });
        }
        continue;
      }
      if (doc.status === "registration") {
        if (doc.registrationClosesAt != null && Date.now() >= doc.registrationClosesAt) {
          await withTournamentLock(doc.id, async () => {
            const fresh = await getTournamentDoc(doc.id);
            if (!fresh || fresh.status !== "registration") return;
            if (fresh.registrationClosesAt == null || Date.now() < fresh.registrationClosesAt) return;
            await processRegistrationDeadline(fresh);
          });
          continue;
        }
        // startWhenFull safety net: a fill that raced a crash between the
        // cap write and onFieldFilled converges here.
        if (doc.startWhenFull === true && activeEntryCount(doc) >= doc.maxPlayers) {
          await withTournamentLock(doc.id, async () => {
            const fresh = await getTournamentDoc(doc.id);
            if (!fresh || fresh.status !== "registration") return;
            if (activeEntryCount(fresh) < fresh.maxPlayers) return;
            await onFieldFilled(fresh);
          });
        }
        continue;
      }
      if (doc.status === "locked") {
        await withTournamentLock(doc.id, () => autoStartIfDue(doc));
        continue;
      }
      if (doc.status === "in_progress") {
        await withTournamentLock(doc.id, () => finalizeArenaIfDue(doc));
        // Intermission: deal a scheduled round whose break has elapsed. Runs
        // before progression so a due round is never pre-empted by a sweep
        // that would see the previous round as "complete but not advanced".
        await withTournamentLock(doc.id, () => fireDueRoundIfScheduled(doc).catch(() => undefined));
        // Stale-round recovery: a crash between a result landing and round
        // generation (or between the last game of a final round and
        // completion) must not leave the event frozen. ensureNextRoundInner
        // is a no-op when the round is still live; maybeProgressAfterResult
        // advances and completes when it is not.
        await withTournamentLock(doc.id, () =>
          maybeProgressAfterResult(doc.id).catch(() => undefined),
        );
        continue;
      }
      // completed / cancelled: settlement (below) is their only work.
    } catch {
      // One bad tournament must not block the rest of the sweep.
    }
  }
  // Phase 3B: money obligations of terminal paid events advance here —
  // payout dispatch/verify, refund dispatch/verify, aggregate status. Every
  // step idempotent; a second run converges to the same state.
  try {
    const { runSettlementSweep } = await import("@/lib/server/tournament-settlement");
    await runSettlementSweep();
  } catch {
    // Settlement must never break the lifecycle sweep that precedes it.
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Entries that are actually in the event: not left (registration window)
 * and not withdrawn (mid-event exit after start). Withdrawn players keep
 * every completed result and their standings row, but never receive a new
 * pairing and never block a round's completion.
 */
function activeEntries(doc: TournamentDocument): TournamentEntry[] {
  return doc.entries.filter((e) => e.leftAt === undefined && e.withdrawnAt === undefined);
}

function activeEntryCount(doc: TournamentDocument): number {
  return activeEntries(doc).length;
}

export async function joinTournament(
  tournamentId: string,
  playerId: string,
): Promise<TransitionResult> {
  // Banned players hit this door (and the paid-entry door) everywhere.
  const ban = await requireNotBanned(playerId);
  if (!ban.ok) return { ok: false, error: ban.error! };
  // The document lock is what makes the player-cap race-free: without it,
  // six concurrent joins each read 0 entries, each pass the cap, and all 6
  // write back 6 entries for a 4-player event.
  return withTournamentLock(tournamentId, () => joinTournamentInner(tournamentId, playerId));
}

async function joinTournamentInner(
  tournamentId: string,
  playerId: string,
): Promise<TransitionResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };

  if (isTournamentTerminal(doc.status)) {
    return { ok: false, error: `Tournament is ${doc.status}` };
  }
  if (doc.status === "in_progress") {
    return { ok: false, error: "Registration has closed, the tournament is running" };
  }
  if (doc.status === "locked") {
    return { ok: false, error: "Registration is locked" };
  }
  if (doc.status !== "registration") {
    return { ok: false, error: "Registration is not open yet" };
  }
  if (
    doc.registrationClosesAt !== null &&
    Date.now() >= doc.registrationClosesAt
  ) {
    return { ok: false, error: "Registration window has closed" };
  }

  const existing = doc.entries.find((e) => e.playerId === playerId);
  if (existing && existing.leftAt === undefined) {
    return { ok: false, error: "You have already joined this tournament" };
  }
  if (activeEntryCount(doc) >= doc.maxPlayers) {
    // The fast store is the source of truth for the field: full means full.
    // (The cross-instance race is covered AFTER the write below — a loser of
    // a genuine cold-instance race withdraws itself deterministically. The
    // durable mirror must never override a fast-store "full" here: when it is
    // unconfigured or hiccups it returns "no answer", and a cap is a promise
    // the engine cannot quietly reopen.)
    return { ok: false, error: "The tournament is full" };
  }

  const now = Date.now();
  if (existing) {
    // Re-join after leaving during registration: reuse the entry. A paid
    // entry that was verified before leaving keeps its payment — the ledger
    // row (unique per tournament+player) still proves it.
    delete existing.leftAt;
    existing.joinedAt = now;
  } else {
    doc.entries.push({ playerId, joinedAt: now });
  }
  await writeTournamentDoc(doc);
  // The 17th seat can never open: re-read AFTER the write and undo if a
  // concurrent joiner slipped past their own pre-check. Cheap (one read),
  // and it converts "eventually noticed too many players" into "the loser
  // of the race is refunded their join immediately".
  const fresh = await getTournamentDoc(tournamentId);
  if (
    fresh &&
    fresh.entries.filter((e) => e.leftAt === undefined).length > doc.maxPlayers
  ) {
    // Two racers must agree on WHO withdraws, or both pulling themselves out
    // would drop the field below the cap. Deterministic rule both compute
    // from the same data: the latest join (joinedAt, then id) withdraws.
    const actives = fresh.entries
      .filter((e) => e.leftAt === undefined)
      .sort((a, b) => b.joinedAt - a.joinedAt || (a.playerId < b.playerId ? 1 : -1));
    const loser = actives[0];
    const mine = fresh.entries.find((e) => e.playerId === playerId);
    if (
      mine &&
      mine.leftAt === undefined &&
      !mine.paid &&
      loser &&
      loser.playerId === playerId
    ) {
      mine.leftAt = Date.now(); // withdrawn: frees the seat, keeps the record
      await writeTournamentDoc(fresh);
      return { ok: false, error: "The tournament just filled up — try again later" };
    }
  }
  // Registration auto-close on the cap. The host's startWhenFull choice
  // decides whether "full" means "locked and playing now" or "locked and
  // waiting". Runs after the write, under the same lock.
  if (activeEntryCount(doc) >= doc.maxPlayers) {
    await onFieldFilled(doc);
  }
  return { ok: true, doc };
}

export async function leaveTournament(
  tournamentId: string,
  playerId: string,
): Promise<TransitionResult> {
  return withTournamentLock(tournamentId, () => leaveTournamentInner(tournamentId, playerId));
}

async function leaveTournamentInner(
  tournamentId: string,
  playerId: string,
): Promise<TransitionResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  if (doc.status === "in_progress") {
    // After start, leaving becomes WITHDRAWAL: keep every completed result
    // and the standings row, but no future pairings. Entry fees stay locked.
    return withdrawFromTournamentInner(tournamentId, playerId);
  }
  if (isTournamentTerminal(doc.status)) {
    return { ok: false, error: `Tournament is ${doc.status}` };
  }
  const entry = doc.entries.find((e) => e.playerId === playerId);
  if (!entry || entry.leftAt !== undefined) {
    return { ok: false, error: "You are not registered in this tournament" };
  }
  // Phase 2B: leaving a PAID tournament before lock returns the fee. The
  // refund obligation is durable and keyed per player, so repeated calls
  // (or a retry after a crash) can never create a second one. The payment
  // stays in the ledger history, but it no longer counts toward the prize
  // pool: the seat was vacated, the money must go back.
  let refundRecorded = false;
  if (isPaidTournamentDoc(doc) && entry.paid) {
    doc.refunds = doc.refunds ?? {};
    const existing = doc.refunds[playerId];
    // ONE refund row per (tournament, player) — schema-mandated (0012).
    //   none      → create the obligation for THIS payment
    //   verified  → the previous return completed; replace with the new one
    //   otherwise → an obligation is already in flight; it keeps its tx.
    //               The newer payment stays in the auditable ledger, and the
    //               event still shows refund_required — nothing is hidden.
    if (!existing || existing.status === "verified") {
      doc.refunds[playerId] = {
        playerId,
        entryTxHash: entry.paid.txHash,
        amountLuna: entryFeeLunaOf(doc).toString(),
        status: "owed",
        refundTxHash: null,
        attempts: 0,
        lastError: null,
        createdAt: Date.now(),
        verifiedAt: null,
      };
    }
    // The seat is vacated and the fee is leaving: the entry is no longer
    // paid. (Otherwise a free-path rejoin would resurrect a "paid" seat
    // whose money is being refunded — a real accounting hole.)
    entry.paid = undefined;
    refundRecorded = doc.refunds[playerId].status !== "verified";
  }
  entry.leftAt = Date.now();
  await writeTournamentDoc(doc);
  // Mirror refund rows AFTER the document persists (mirror can never outpace
  // the fast store).
  const refundRecord = doc.refunds?.[playerId];
  if (refundRecord) {
    const { mirrorRefund } = await import("@/lib/server/tournament-store");
    await mirrorRefund(doc.id, refundRecord).catch(() => undefined);
  }
  // Aggregate status reflects any outstanding refund.
  if (refundRecorded) {
    const fresh = await getTournamentDoc(tournamentId);
    if (fresh && fresh.payoutStatus !== "refunded") {
      fresh.payoutStatus = "refund_required";
      await writeTournamentDoc(fresh);
      return { ok: true, doc: fresh };
    }
  }
  return { ok: true, doc };
}

/** Withdraw mid-event: keep results, stop future pairings, fee stays locked. */
async function withdrawFromTournamentInner(
  tournamentId: string,
  playerId: string,
): Promise<TransitionResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  const entry = doc.entries.find((e) => e.playerId === playerId);
  if (!entry || entry.leftAt !== undefined) {
    return { ok: false, error: "You are not registered in this tournament" };
  }
  if (entry.withdrawnAt !== undefined) {
    return { ok: true, doc }; // idempotent
  }
  entry.withdrawnAt = Date.now();
  doc.standings = recomputeStandings(doc);
  await writeTournamentDoc(doc);
  // With no unfinished pairing left, their withdrawal may complete the round
  // for everyone else (a Swiss round can now pair / finish, a knockout
  // bracket can advance). Best-effort — progression retries on the next poll.
  if (doc.format !== "arena") {
    await maybeProgressAfterResult(tournamentId).catch(() => undefined);
  }
  return { ok: true, doc };
}

/**
 * Host deletes a tournament that never started (draft or registration).
 * The event is removed entirely — list, detail, durable mirror — rather
 * than parked in CANCELLED, because "no longer wish to host" means it
 * should never have existed. Started events cannot be deleted: their
 * games and standings are real records.
 */
export async function deleteTournament(
  tournamentId: string,
  playerId: string,
): Promise<TransitionResult> {
  return withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return { ok: false, error: "Tournament not found" };

    // Delete is an ADMIN-ONLY action once real money is involved. A host may
    // still delete their own event ONLY while it is untouched: draft/locked
    // with no third-party payment verified, or a paid event nobody but the
    // host has paid into (host self-payment does not lock deletion — they
    // can delete their own 1-entry event). The moment any other player has
    // a verified paid seat, only an admin can remove the event: the paid
    // seats are real funds and the admin dashboards is where accountability
    // lives.
    const isAdmin = await isAdminPlayer(playerId);
    const thirdPartyPaid = doc.entries.some(
      (e) => e.paid && e.leftAt === undefined && e.playerId !== doc.creatorId,
    );
    const hostMayDelete =
      doc.creatorId === playerId &&
      !thirdPartyPaid &&
      (doc.status === "draft" || doc.status === "locked" || doc.status === "registration");
    if (!isAdmin && !hostMayDelete) {
      if (thirdPartyPaid) {
        return {
          ok: false,
          error:
            "This tournament has paid entries, only a ChainMate administrator can delete it",
        };
      }
      if (doc.creatorId === playerId) {
        return {
          ok: false,
          error: `Tournament is ${doc.status} — cancel it instead`,
        };
      }
      return { ok: false, error: "Only the host or an administrator can delete the tournament" };
    }
    if (
      !isAdmin &&
      (doc.status === "in_progress" || isTournamentTerminal(doc.status))
    ) {
      return {
        ok: false,
        error: doc.status === "in_progress"
          ? "The tournament is running, end or cancel it instead"
          : `Tournament is ${doc.status}`,
      };
    }
    await deleteTournamentDoc(tournamentId);
    return { ok: true, doc };
  });
}

/* ------------------------------------------------------------------ */
/* Pairing — the three formats                                         */
/* ------------------------------------------------------------------ */

function activeGameFor(doc: TournamentDocument, playerId: string): TournamentMatch | null {
  return (
    doc.matches.find(
      (m) =>
        m.status !== "complete" &&
        (m.whitePlayerId === playerId || m.blackPlayerId === playerId),
    ) ?? null
  );
}

/**
 * Players with no unfinished match this round/window who are still IN the
 * event — a withdrawn player is never paired again and never counted as an
 * unresolved game (no dead browser tab can freeze a round).
 */
function idlePlayers(doc: TournamentDocument, playerIds: string[]): string[] {
  const withdrawn = new Set(
    doc.entries.filter((e) => e.withdrawnAt !== undefined).map((e) => e.playerId),
  );
  return playerIds.filter(
    (id) => !withdrawn.has(id) && !activeGameFor(doc, id),
  );
}

/**
 * Pair two players and create the underlying hosted ChainMate game.
 * Returns null when a concurrent writer changed the document underneath us
 * (caller may retry once).
 */
async function createMatch(
  doc: TournamentDocument,
  white: string,
  black: string,
  round: number,
  slot: number,
): Promise<TournamentMatch> {
  // Colour alternation by id sort keeps this deterministic across instances:
  // the lexicographically lower id of the pair is White on even slots.
  const [a, b] = [white, black].sort();
  const whiteId = slot % 2 === 0 ? a : b;
  const blackId = whiteId === a ? b : a;

  const game = await createHostedGameForTournament(doc, whiteId, blackId);
  const match: TournamentMatch = {
    id: newMatchId(),
    tournamentId: doc.id,
    round,
    slot,
    whitePlayerId: whiteId,
    blackPlayerId: blackId,
    gameId: game.id,
    status: "active",
    createdAt: Date.now(),
  };
  doc.matches.push(match);
  // The O(1) lookup the end-of-game hook uses to find this tournament.
  await recordTournamentGame(game.id, doc.id);
  return match;
}

/**
 * Reuse the hosted game factory so tournament boards are ordinary ChainMate
 * games (same store, same lifecycle, same ratings behaviour). Visibility is
 * public so tournament boards show up in Watch like any other live game.
 */
async function createHostedGameForTournament(
  doc: TournamentDocument,
  white: string,
  black: string,
): Promise<GameState> {
  const { createHostedGame, joinHostedGame, writeHostedGameWithChat } = await import(
    "@/lib/server/hosted",
  );
  const game = await createHostedGame(white, {
    timeControl: doc.timeControl,
    visibility: "public",
  });
  // Tag the match with its tournament BEFORE Black joins, so the tag is on
  // the game before it can ever end and the achievement engine can see it.
  game.tournamentId = doc.id;
  await writeHostedGameWithChat(game);
  // A tournament match starts immediately — Black joins, game goes active.
  // (joinHostedGame(id, playerId) — the game id comes first.)
  await joinHostedGame(game.id, black);
  return game;
}

/**
 * Generate the next round (knockout / swiss). Idempotent: if the round is
 * already generated (or the previous one is unfinished), it is a no-op.
 * Arena tournaments never call this.
 */
export async function ensureNextRound(tournamentId: string): Promise<TransitionResult> {
  return withTournamentLock(tournamentId, () => ensureNextRoundInner(tournamentId));
}

async function ensureNextRoundInner(tournamentId: string): Promise<TransitionResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  if (doc.status !== "in_progress") {
    return { ok: false, error: "The tournament is not running" };
  }
  if (doc.format === "arena") {
    return { ok: false, error: "Arena tournaments pair on demand" };
  }

  const nextRound = doc.currentRound + 1;
  if (doc.format === "swiss" && nextRound > (doc.swissRounds ?? SWISS_DEFAULT_ROUNDS)) {
    return { ok: true, doc }; // all Swiss rounds played — completion is handled elsewhere
  }

  const entrants = activeEntries(doc).map((e) => e.playerId);

  // --- KNOCKOUT: winners of the previous round advance, straight bracket. ---
  if (doc.format === "knockout") {
    if (nextRound === 1) {
      // Seed by registration order (deterministic), fill to a power of two
      // with byes — the lowest seeds receive them (standard practice).
      const seeds = [...entrants].sort(
        (a, b) => joinOrder(doc, a) - joinOrder(doc, b) || (a < b ? -1 : 1),
      );
      const size = 1 << knockoutRoundCount(seeds.length);
      // Standard seeding: seed k meets seed size+1-k in round 1. Seed s (1-based)
      // takes slot `s-1` XOR-folded so adjacent pairs are 1-v-last, 2-v-…:
      // slot = bit-reverse of (s-1) over log2(size) bits.
      const bracket: (string | null)[] = Array.from({ length: size }, () => null);
      for (let i = 0; i < seeds.length; i++) {
        const pos = seedPosition(i + 1, size);
        bracket[pos] = seeds[i];
      }
      // Unfilled slots (byes) sit next to the highest seeds; the bye holder
      // advances without playing. Represented as an auto-complete marker so
      // later rounds see them as winners.
      let slot = 0;
      for (let i = 0; i < size; i += 2) {
        const a = bracket[i];
        const b = bracket[i + 1];
        if (a && b) {
          await createMatch(doc, a, b, 1, slot++);
        } else if (a || b) {
          const holder = (a ?? b)!;
          doc.matches.push({
            id: newMatchId(),
            tournamentId: doc.id,
            round: 1,
            slot: slot++,
            whitePlayerId: holder,
            blackPlayerId: BYE_OPPONENT,
            gameId: "",
            status: "complete",
            result: "white",
            resultReason: "bye",
            createdAt: Date.now(),
            completedAt: Date.now(),
          });
        }
      }
      doc.currentRound = 1;
      await writeTournamentDoc(doc);
      return { ok: true, doc };
    }

    // Later rounds: winners advance. The round is ready when every match of
    // the previous round is complete (byes are already complete markers).
    const prevMatches = doc.matches.filter(
      (m) => m.round === nextRound - 1 && m.blackPlayerId !== SWISS_BYE_OPPONENT,
    );
    if (prevMatches.some((m) => m.status !== "complete")) {
      return { ok: true, doc }; // previous round still running
    }
    const winners = prevMatches.map((m) =>
      m.result === "white" ? m.whitePlayerId : m.blackPlayerId,
    );
    if (winners.length <= 1) {
      // Tournament over: crown the winner. Inner variant (already locked).
      return completeTournamentInner(tournamentId, winners[0] ?? null);
    }
    let slot = 0;
    for (let i = 0; i + 1 < winners.length; i += 2) {
      await createMatch(doc, winners[i], winners[i + 1], nextRound, slot++);
    }
    if (winners.length % 2 === 1) {
      // Should not happen in a properly sized bracket; guard anyway — the odd
      // winner advances unopposed via a bye marker.
      const oddOne = winners[winners.length - 1];
      doc.matches.push({
        id: newMatchId(),
        tournamentId: doc.id,
        round: nextRound,
        slot: slot++,
        whitePlayerId: oddOne,
        blackPlayerId: BYE_OPPONENT,
        gameId: "",
        status: "complete",
        result: "white",
        resultReason: "bye",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
    }
    doc.currentRound = nextRound;
    doc.standings = recomputeStandings(doc);
    await writeTournamentDoc(doc);
    return { ok: true, doc };
  }

  // --- SWISS: pair by standings, avoiding repeat pairings where possible. ---
  const standings = recomputeStandings(doc);
  const order = standings
    .map((s) => s.playerId)
    .filter((id) => entrants.includes(id));
  const pairs = pairSwissRound(doc, order);
  let slot = 0;
  for (const [a, b] of pairs) {
    await createMatch(doc, a, b, nextRound, slot++);
  }
  // Odd player out gets a bye: 1 free point, recorded as a marker match that
  // the standings module treats as a point WITHOUT a game (no played, no
  // win for tiebreaks, no Buchholz contribution).
  //
  // FAIRNESS: the bye goes to the LOWEST-ranked player who has not had one
  // yet (never the same player twice), falling back to the lowest-ranked
  // player overall when everyone has already had one. Standard Swiss
  // practice — byes are a disadvantage, so they rotate downward deterministically.
  if (order.length % 2 === 1) {
    const paired = new Set(pairs.flat());
    const unpaired = order.filter((id) => !paired.has(id));
    const byedBefore = new Set(
      doc.matches
        .filter((m) => m.resultReason === "bye")
        .map((m) => (m.whitePlayerId === SWISS_BYE_OPPONENT ? m.blackPlayerId : m.whitePlayerId)),
    );
    const bye = unpaired.find((id) => !byedBefore.has(id)) ?? unpaired[unpaired.length - 1];
    if (bye) {
      doc.matches.push({
        id: newMatchId(),
        tournamentId: doc.id,
        round: nextRound,
        slot: slot++,
        whitePlayerId: bye,
        blackPlayerId: SWISS_BYE_OPPONENT,
        gameId: "",
        status: "complete",
        result: "white",
        resultReason: "bye",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
    }
  }
  doc.currentRound = nextRound;
  doc.standings = recomputeStandings(doc);
  await writeTournamentDoc(doc);
  return { ok: true, doc };
}

function joinOrder(doc: TournamentDocument, playerId: string): number {
  const idx = doc.entries.findIndex(
    (e) => e.playerId === playerId && e.leftAt === undefined,
  );
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** Standard single-elimination seed position (0-based slot). */
function seedPosition(seed: number, size: number): number {
  // Bit-reversal permutation: seed s (1-based) lands at the bit-reverse of
  // s-1 over log2(size) bits, which makes round 1 read 1-v-size, then
  // size/2+1-v-size/2, and so on — the classic bracket order.
  let v = seed - 1;
  let pos = 0;
  for (let bits = size >> 1; bits > 0; bits >>= 1) {
    pos = (pos << 1) | (v & 1);
    v >>= 1;
  }
  return pos;
}

/** Sentinel opponent for knockout byes (auto-advance markers). */
const BYE_OPPONENT = "__bye__";

/**
 * Resolve ONE knockout match to an advancing player.
 *
 * Draws: the bracket must never stay unresolved. Policy (documented for the
 * UI): a drawn game is recorded, then a DECISIVE replay is generated
 * immediately — same time control, colours re-flipped so the player who had
 * White now has Black. Replays continue until a decisive result. Every
 * replay's game id is archived on the match (tiebreakGameIds) so the record
 * is auditable. The server determines the advancing player from real game
 * results only.
 *
 * Aborted games: never a loss for either player (nothing was decided). The
 * withdrawal/default rule applies instead — the BETTER SEED advances, where
 * seeding is registration order (the same deterministic order the bracket
 * itself was built from). An eliminated-looking player can never lose a
 * match they did not play.
 *
 * Returns null only for an unfinished match.
 */
function knockoutAdvancer(
  doc: TournamentDocument,
  match: TournamentMatch,
): string | null {
  if (match.status !== "complete") return null;
  if (match.result === "white") return match.whitePlayerId;
  if (match.result === "black") return match.blackPlayerId;
  if (match.resultReason === "aborted" || !match.result) {
    // Abort default: better seed advances. Registration order is the
    // deterministic seed; the earlier joiner is the better seed.
    const wBetter = joinOrder(doc, match.whitePlayerId) <= joinOrder(doc, match.blackPlayerId);
    return wBetter ? match.whitePlayerId : match.blackPlayerId;
  }
  return null;
}

/**
 * Schedule the decisive replay for a DRAWN knockout game (lock held, doc
 * fresh). THE MATCH IS MUTATED IN PLACE: the drawn game id is archived in
 * tiebreakGameIds and the SAME match row is repointed at the new hosted
 * game. A second match row for the same pair would freeze the bracket
 * forever (progression reads one match per slot and would see an
 * unresolved duplicate), so it must never exist.
 *
 * Colours flip: tiebreak slot parity +1 inverts createMatch's alternation,
 * so the player who had White now has Black. Replays continue until a
 * decisive result; every replayed game id is archived for audit.
 *
 * Idempotent by construction: only an ACTIVE match with a terminal game
 * reaches here, and once gameId points at the replay the drawn game cannot
 * re-trigger it.
 */
async function scheduleKnockoutTiebreak(
  doc: TournamentDocument,
  match: TournamentMatch,
): Promise<void> {
  if (match.status !== "active") return; // guard: only a live match replays
  // Archive the drawn game.
  match.tiebreakGameIds = [...(match.tiebreakGameIds ?? []), match.gameId];
  // Colours flip: tiebreak slot parity +1 inverts createMatch's alternation.
  await createMatch(doc, match.whitePlayerId, match.blackPlayerId, match.round, match.slot + 1);
  // createMatch PUSHES a new match row — find it (same pair, latest) and
  // MERGE it into the original row, so the bracket keeps exactly one row
  // per slot: the replay's game id, still active.
  const replay = [...doc.matches]
    .reverse()
    .find((m) => m !== match && m.gameId && (m.whitePlayerId === match.whitePlayerId && m.blackPlayerId === match.blackPlayerId || m.whitePlayerId === match.blackPlayerId && m.blackPlayerId === match.whitePlayerId));
  if (!replay) throw new Error("Tiebreak replay row not found");
  doc.matches.splice(doc.matches.indexOf(replay), 1);
  match.gameId = replay.gameId;
  match.status = "active";
  match.result = undefined;
  match.resultReason = undefined;
  match.completedAt = undefined;
}

/**
 * Swiss pairing for one round, given players ordered by standings (best
 * first). Greedy downflow: the top unpaired player meets the closest-ranked
 * unpaired opponent they have NOT already played; only when every remaining
 * candidate is a rematch does the closest one get used anyway. Repeat
 * pairings are prevented *where possible* — with a small field and many
 * rounds, avoidance must eventually yield (documented in the standings
 * module: prevention is best-effort by design, ranking is deterministic).
 */
export function pairSwissRound(
  doc: TournamentDocument,
  orderedPlayerIds: string[],
): [string, string][] {
  const played = new Set<string>();
  for (const m of doc.matches) {
    if (m.blackPlayerId === SWISS_BYE_OPPONENT || m.whitePlayerId === SWISS_BYE_OPPONENT) {
      continue;
    }
    played.add(pairKey(m.whitePlayerId, m.blackPlayerId));
  }
  const pool = [...orderedPlayerIds];
  const pairs: [string, string][] = [];
  const taken = new Set<string>();

  for (const a of pool) {
    if (taken.has(a)) continue;
    let best: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    let bestRematch = true; // worst case: we accept a rematch
    for (const b of pool) {
      if (b === a || taken.has(b)) continue;
      const dist = Math.abs(orderOf(pool, a) - orderOf(pool, b));
      const rematch = played.has(pairKey(a, b));
      // A fresh pairing always beats a rematch; otherwise closer rank wins.
      if (
        best === null ||
        (bestRematch && !rematch) ||
        (rematch === bestRematch && dist < bestDist)
      ) {
        best = b;
        bestDist = dist;
        bestRematch = rematch;
      }
    }
    if (best !== null) {
      taken.add(a);
      taken.add(best);
      pairs.push([a, best]);
    }
  }
  return pairs;
}

function orderOf(list: string[], id: string): number {
  return list.indexOf(id);
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/* ------------------------------------------------------------------ */
/* Arena pairing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Pair one idle arena player against another idle player, avoiding repeats
 * where possible. Returns the match, or null when no opponent is available
 * (odd player out, everyone busy, or the player already has an active game).
 */
export async function requestArenaPairing(
  tournamentId: string,
  playerId: string,
): Promise<{ ok: boolean; match?: TournamentMatch; error?: string }> {
  // Locked like joins: two players racing to pair must not both read each
  // other as idle and end up in two games.
  return withTournamentLock(tournamentId, () => requestArenaPairingInner(tournamentId, playerId));
}

async function requestArenaPairingInner(
  tournamentId: string,
  playerId: string,
): Promise<{ ok: boolean; match?: TournamentMatch; error?: string }> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  if (doc.status !== "in_progress") {
    return { ok: false, error: "The tournament is not running" };
  }
  if (doc.format !== "arena") {
    return { ok: false, error: "Pairing on demand is only for arena tournaments" };
  }
  const entrants = new Set(activeEntries(doc).map((e) => e.playerId));
  if (!entrants.has(playerId)) {
    return { ok: false, error: "You are not registered in this tournament" };
  }
  // One active tournament game per player — the core arena invariant.
  if (activeGameFor(doc, playerId)) {
    return { ok: false, error: "You already have an active game in this tournament" };
  }

  const played = new Set<string>();
  for (const m of doc.matches) {
    played.add(pairKey(m.whitePlayerId, m.blackPlayerId));
  }
  const candidates = idlePlayers(doc, [...entrants]).filter((id) => id !== playerId);
  // Closest by standings, fresh pairing preferred.
  const standings = recomputeStandings(doc);
  const rankOf = new Map(standings.map((s) => [s.playerId, s.rank]));
  candidates.sort((a, b) => {
    const rematchA = played.has(pairKey(playerId, a));
    const rematchB = played.has(pairKey(playerId, b));
    if (rematchA !== rematchB) return rematchA ? 1 : -1;
    return (rankOf.get(a) ?? 999) - (rankOf.get(b) ?? 999);
  });
  const opponent = candidates[0];
  if (!opponent) {
    return { ok: false, error: "No opponent is free right now, try again in a moment" };
  }
  const match = await createMatch(doc, playerId, opponent, 0, doc.matches.length);
  await writeTournamentDoc(doc);
  return { ok: true, match };
}

/* ------------------------------------------------------------------ */
/* Standings & result ingestion                                        */
/* ------------------------------------------------------------------ */

function recomputeStandings(doc: TournamentDocument): StandingRow[] {
  if (doc.format === "knockout") {
    return computeKnockoutStandings(doc.matches, activeEntries(doc));
  }
  return computeStandings(doc.format, doc.matches, activeEntries(doc));
}

/**
 * React to an authoritative game result. Called by the end-of-game paths in
 * lib/server/hosted.ts for every game that carries a tournament match id —
 * and by nothing else. The result comes from the game state itself, never
 * from the client.
 *
 * IDEMPOTENT: the match row is only advanced on the first call per game;
 * later calls (double ingestion, replayed hooks, re-reads) see
 * status === "complete" and return without touching standings.
 */
export async function ingestTournamentGameResult(
  gameId: string,
  game: GameState,
): Promise<void> {
  if (!gameId || !isGameOver(game.status)) return;
  const tournamentId = await findTournamentForGame(gameId);
  if (!tournamentId) return;
  // Locked: a result landing while round generation is mid-flight must
  // either land before or after it, never inside it.
  return withTournamentLock(tournamentId, () => ingestInner(tournamentId, gameId, game));
}

async function ingestInner(
  tournamentId: string,
  gameId: string,
  game: GameState,
): Promise<void> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return;

  const match = doc.matches.find((m) => m.gameId === gameId);
  if (!match) return;
  // Already processed — the double-count guard.
  if (match.status === "complete") return;

  const status = game.status as GameStatus;
  // KNOCKOUT DRAWS: a drawn knockout game can never leave the bracket
  // stuck. The drawn result is RECORDED for the audit trail, then a
  // decisive replay is generated immediately (same match row, colours
  // flipped). The replay's result later overwrites the draw on the same
  // match, so exactly one advancement ever comes out of this pairing.
  if (doc.format === "knockout" && status !== "aborted" && !game.winner) {
    match.result = "draw";
    match.resultReason = status;
    match.tiebreakGameIds = [...(match.tiebreakGameIds ?? []), match.gameId];
    await writeTournamentDoc(doc); // persist the audit trail first
    try {
      await scheduleKnockoutTiebreak(doc, match);
    } catch {
      // Replay creation failed (store hiccup): the match stays recorded as
      // a draw; the maintenance sweep re-detects a drawn knockout match and
      // re-schedules the replay. The bracket is never silently stuck.
    }
    await writeTournamentDoc(doc);
    return; // nothing advanced yet — the replay decides
  }

  // Aborted games never happened: the match is voided, no standings impact.
  if (status === "aborted") {
    match.status = "complete";
    match.resultReason = "aborted";
    match.completedAt = Date.now();
  } else if (!game.winner) {
    // Draw (Swiss/Arena): half point to each side. All existing draw-ish
    // terminal states land here (stalemate, agreement, repetition…).
    match.status = "complete";
    match.result = "draw";
    match.resultReason = status;
    match.completedAt = Date.now();
  } else {
    match.status = "complete";
    match.result = game.winner === game.creator ? "white" : "black";
    match.resultReason = status;
    match.completedAt = Date.now();
  }

  doc.standings = recomputeStandings(doc);
  await writeTournamentDoc(doc);

  // Post-round progression for formats with rounds. Best-effort: a failure
  // here must not corrupt the result just recorded.
  if (doc.format !== "arena") {
    try {
      await maybeProgressAfterResult(doc.id);
    } catch {
      // progression is retried by the next poll of ensureNextRound
    }
  } else {
    await checkArenaCompletion(doc.id).catch(() => {});
  }
}

/** Which tournament (if any) holds a match on this game — from the mirror first, fast store second. */
async function findTournamentForGame(gameId: string): Promise<string | null> {
  // The fast store is authoritative and cheap; scanning the index is bounded
  // by INDEX_MAX (200) and tournaments in progress are few. A dedicated
  // gameId → tournamentId map is not worth another document to keep in sync.
  const { tournamentIdForGame } = await import("@/lib/server/tournament-store");
  return tournamentIdForGame(gameId);
}

/**
 * After a result: advance the bracket / generate the next Swiss round /
 * complete the tournament when it is actually over.
 */
async function maybeProgressAfterResult(tournamentId: string): Promise<void> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc || doc.status !== "in_progress") return;

  if (doc.format === "knockout") {
    const roundMatches = doc.matches.filter((m) => m.round === doc.currentRound);
    if (roundMatches.length === 0) return;
    // A DRAWN knockout match never resolves on its own: reschedule its
    // decisive replay (idempotent — only fires when the referenced game is
    // terminal-drawn and no replay exists yet). The round stays open until
    // a decisive result lands, exactly as the brief requires.
    for (const m of roundMatches) {
      if (m.status === "complete" && m.result === "draw" && m.resultReason !== "aborted") {
        // Reactivate the REAL row (not a copy) so the round correctly reads
        // unresolved while the replay runs, and reschedule it.
        m.status = "active";
        await scheduleKnockoutTiebreak(doc, m).catch(() => {
          // Replay creation failed: keep the draw recorded; the next sweep
          // retries. The bracket shows the drawn game meanwhile.
          m.status = "complete";
        });
      }
    }
    if (roundMatches.some((m) => m.status !== "complete")) {
      return; // round still running (a rescheduled replay is active again)
    }
    // Resolve every match through ONE advancer — the same function the
    // bracket builder uses — so a draw/abort can never silently hand the
    // match to Black via the old `result === "white" ? white : black` trap.
    const winners = roundMatches
      .map((m) => knockoutAdvancer(doc, m))
      .filter((id): id is string => id !== null);
    if (winners.length === 1) {
      await completeTournamentInner(tournamentId, winners[0]);
      return;
    }
    // Every match resolved — build the next round. Byes can make
    // winners.length odd: an odd winner gets a free pass (documented).
    await scheduleNextRoundAfterIntermission(tournamentId);
    return;
  }

  if (doc.format === "swiss") {
    const roundMatches = doc.matches.filter(
      (m) => m.round === doc.currentRound && m.blackPlayerId !== SWISS_BYE_OPPONENT,
    );
    if (roundMatches.length === 0 || roundMatches.some((m) => m.status !== "complete")) {
      return;
    }
    const playedRounds = doc.currentRound;
    if (playedRounds >= (doc.swissRounds ?? SWISS_DEFAULT_ROUNDS)) {
      // All configured rounds done — complete with the standings winner.
      await completeTournamentInner(tournamentId, null);
      return;
    }
    await scheduleNextRoundAfterIntermission(tournamentId);
  }
}

/**
 * A round just finished but more rounds remain: schedule the next one after
 * the intermission instead of dealing it on top of the result screen.
 * Idempotent: a second call (race, retry, the maintenance sweep) sees the
 * scheduled instant already set and leaves it alone.
 */
async function scheduleNextRoundAfterIntermission(tournamentId: string): Promise<void> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc || doc.status !== "in_progress") return;
  const remaining =
    doc.format === "swiss"
      ? (doc.swissRounds ?? SWISS_DEFAULT_ROUNDS) - doc.currentRound
      : doc.totalRounds - doc.currentRound;
  if (remaining <= 0) {
    // No rounds left — this was the final one; complete now (standings win).
    await completeTournamentInner(tournamentId, null);
    return;
  }
  if (doc.nextRoundAt != null) return; // already scheduled
  doc.nextRoundAt = Date.now() + ROUND_INTERMISSION_MS;
  await writeTournamentDoc(doc);
  // Zero intermission (tests, or an instant-flow deployment): fire the round
  // right here so progression never depends on the maintenance sweep running.
  if (ROUND_INTERMISSION_MS === 0) {
    await fireDueRoundIfScheduled(doc);
  }
}

/**
 * Fire a scheduled round whose intermission has elapsed (lock held).
 * Idempotent: clears the instant BEFORE generation so a concurrent sweep
 * cannot double-deal; ensureNextRoundInner is itself a no-op when the round
 * is already open.
 */
async function fireDueRoundIfScheduled(doc: TournamentDocument): Promise<void> {
  if (doc.status !== "in_progress") return;
  if (doc.nextRoundAt == null || Date.now() < doc.nextRoundAt) return;
  doc.nextRoundAt = null;
  await writeTournamentDoc(doc);
  await ensureNextRoundInner(doc.id).catch(() => undefined);
}

/**
 * Arena completion: the host may end the event at any time while it runs
 * (transition to completed). There is no automatic end — the window is
 * host-controlled. This helper is where an automatic condition could live
 * later; today it only keeps the standings fresh.
 */
async function checkArenaCompletion(tournamentId: string): Promise<void> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc || doc.format !== "arena") return;
  doc.standings = recomputeStandings(doc);
  await writeTournamentDoc(doc);
}

/**
 * Server-side completion. winnerId may be null (Swiss completion reads the
 * standings; a knockout always names a winner). Never called with a
 * client-supplied id — only from the engine's own progression logic or the
 * host's explicit complete action (which still goes through validation).
 */
/**
 * Trophies for a finished tournament, idempotent: the champion gets the
 * legendary trophy, and every player who played at least one match gets the
 * bronze debutant. Runs on every completion path (host click, engine).
 */
async function awardTournamentTrophies(doc: TournamentDocument): Promise<void> {
  const { awardAchievementCode } = await import("@/lib/server/hosted");
  if (doc.winnerId) {
    await awardAchievementCode(doc.winnerId, "TOURNEY_CHAMPION").catch(() => undefined);
  }
  for (const s of doc.standings) {
    if (s.played > 0) {
      await awardAchievementCode(s.playerId, "FIRST_TOURNAMENT").catch(() => undefined);
    }
  }
}

export async function completeTournament(
  tournamentId: string,
  winnerId: string | null,
): Promise<TransitionResult> {
  return withTournamentLock(tournamentId, () => completeTournamentInner(tournamentId, winnerId));
}

async function completeTournamentInner(
  tournamentId: string,
  winnerId: string | null,
): Promise<TransitionResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  if (doc.status === "completed") {
    return { ok: true, doc }; // idempotent
  }
  if (doc.status !== "in_progress") {
    return { ok: false, error: "Only a running tournament can be completed" };
  }

  let winner = winnerId;
  if (doc.format === "swiss" || doc.format === "arena") {
    const standings = recomputeStandings(doc);
    const top = standings.find((s) => s.played > 0 || s.points > 0);
    winner = top?.playerId ?? null;
  }
  if (winner && !activeEntries(doc).some((e) => e.playerId === winner)) {
    winner = null; // a withdrawn player cannot be the winner
  }

  const won = await transitionTournamentStatus(doc.id, doc.status, "completed");
  if (!won) return { ok: false, error: "The tournament was already completed elsewhere" };

  doc.status = "completed";
  doc.completedAt = Date.now();
  doc.winnerId = winner;
  doc.standings = recomputeStandings(doc);
  await writeTournamentDoc(doc);
  await awardTournamentTrophies(doc).catch(() => undefined);
  // Engine completions plan the purse too - the host transition is not the
  // only door to COMPLETED (Swiss final round, knockout final, arena window
  // close all arrive here). planTournamentPayouts is idempotent, so the two
  // paths racing converge on one set of payout rows.
  await planPayoutsIfPaid(doc).catch(() => undefined);
  return { ok: true, doc };
}

/* ------------------------------------------------------------------ */
/* Reads for the API                                                   */
/* ------------------------------------------------------------------ */

/**
 * Open registration for any scheduled tournament whose start time has
 * arrived (DRAFT → REGISTRATION, host-free). Called from the list and
 * detail reads, which poll every few seconds — the closest thing this app
 * has to a background scheduler, and good enough: the event opens within
 * one poll of its scheduled instant without any cron infrastructure.
 */
/**
 * Back-compat shim: reads used to run only the scheduled-open sweep. They
 * now run the full time-driven state machine (opens, deadlines, auto-start,
 * arena finals) — every step idempotent, so a poll every few seconds is the
 * app's scheduler without any cron infrastructure.
 */
async function openDueTournaments(): Promise<void> {
  await runTournamentMaintenance();
}

export async function getTournamentDetail(
  tournamentId: string,
  viewerId?: string,
): Promise<{
  summary: TournamentSummary;
  entries: TournamentEntry[];
  rounds: TournamentRound[];
  standings: StandingRow[];
  myRole: "host" | "entrant" | "none";
  myActiveGameId: string | null;
  entryNames: Record<string, string>;
  payouts?: TournamentPayoutLine[];
  refunds?: TournamentRefundLine[];
} | null> {
  await openDueTournaments();
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return null;
  const entrants = activeEntries(doc);

  // Resolve display names for the host and every entrant through the
  // existing player-stats infrastructure (same path Games/Watch use).
  const { getPlayerStats } = await import("@/lib/server/hosted");
  const entryNames: Record<string, string> = {};
  const nameIds = new Set<string>([doc.creatorId, ...entrants.map((e) => e.playerId)]);
  for (const id of nameIds) {
    try {
      const stats = await getPlayerStats(id);
      if (stats.username) entryNames[id] = stats.username;
    } catch {
      // A missing profile never blocks the detail view.
    }
  }

  const rounds: TournamentRound[] = [];
  if (doc.format !== "arena") {
    for (let r = 1; r <= Math.max(doc.currentRound, 1); r++) {
      const matches = doc.matches
        .filter((m) => m.round === r && m.blackPlayerId !== SWISS_BYE_OPPONENT)
        .sort((a, b) => a.slot - b.slot);
      if (matches.length === 0) continue;
      rounds.push({
        index: r,
        // Bracket vocabulary ("Semi-final") belongs to knockout brackets
        // alone: in a Swiss every round carries equal weight, so "Round 2"
        // is the honest label - the live-fire run surfaced this mislabel.
        label:
          doc.format === "knockout"
            ? roundLabel(r, doc.totalRounds || r)
            : `Round ${r}`,
        matches,
        open: matches.some((m) => m.status !== "complete"),
      });
    }
  }

  const myMatch = viewerId ? activeGameFor(doc, viewerId) : null;
  const summary = summaryOf(doc, entrants.length);
  summary.creatorName = entryNames[doc.creatorId];

  // Phase 2B: payout lines for paid tournaments (UI-safe public shape).
  let payouts: TournamentPayoutLine[] | undefined;
  if (isPaidTournamentDoc(doc) && doc.status === "completed") {
    try {
      const { listTournamentPayouts } = await import("@/lib/server/tournament-payouts");
      const records = await listTournamentPayouts(doc.id);
      payouts = records.map((p) => ({
        playerId: p.playerId,
        payoutRank: p.payoutRank,
        shareBps: p.shareBps,
        amountLuna: p.amountLuna,
        status: p.status,
      }));
    } catch {
      payouts = undefined;
    }
  }

  // Refund lines for paid events (cancel / leave-before-lock) — UI-safe.
  let refunds: TournamentRefundLine[] | undefined;
  if (doc.refunds && Object.keys(doc.refunds).length > 0) {
    refunds = Object.values(doc.refunds).map((r) => ({
      playerId: r.playerId,
      amountLuna: r.amountLuna,
      status: r.status,
    }));
  }

  return {
    summary,
    entries: entrants,
    rounds,
    standings: doc.standings.length > 0 ? doc.standings : recomputeStandings(doc),
    refunds,
    myRole:
      viewerId && doc.creatorId === viewerId
        ? "host"
        : viewerId && entrants.some((e) => e.playerId === viewerId)
          ? "entrant"
          : "none",
    myActiveGameId: myMatch?.gameId ?? null,
    entryNames,
    payouts,
  };
}

export function summaryOf(doc: TournamentDocument, playerCount: number): TournamentSummary {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    creatorId: doc.creatorId,
    format: doc.format,
    timeControl: doc.timeControl,
    maxPlayers: doc.maxPlayers,
    status: doc.status,
    playerCount,
    registrationClosesAt: doc.registrationClosesAt,
    scheduledStartAt: doc.scheduledStartAt,
    scheduledEndAt: doc.scheduledEndAt,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    createdAt: doc.createdAt,
    /** Intermission countdown: the instant the next round will be dealt. */
    nextRoundAt: doc.nextRoundAt ?? null,
    /** Client-side mirror of ROUND_INTERMISSION_MS (UI copy uses it). */
    roundIntermissionMs: ROUND_INTERMISSION_MS,
    currentRound: doc.format === "arena" ? undefined : doc.currentRound || undefined,
    totalRounds: doc.format === "arena" ? undefined : doc.totalRounds || undefined,
    winnerId: doc.winnerId,
    // Phase 2B economy fields (additive; older clients ignore them).
    entryFeeLuna: doc.entryFeeLuna ?? null,
    prizePreset: doc.prizePreset ?? null,
    payoutStatus: doc.payoutStatus ?? "none",
    // Lifecycle fields: why a cancelled event died, and what happens when
    // the field fills. Additive; older clients ignore them.
    cancelReason: doc.cancelReason ?? null,
    minPlayers: doc.minPlayers ?? null,
    startWhenFull: doc.startWhenFull ?? false,
  };
}

export async function listTournaments(opts?: {
  status?: TournamentStatus;
  limit?: number;
}): Promise<{ tournaments: TournamentSummary[]; players: Record<string, string> }> {
  await openDueTournaments();
  const docs = await listTournamentDocs({ status: opts?.status, limit: opts?.limit });
  const summaries: TournamentSummary[] = [];
  const playerIds = new Set<string>();
  for (const doc of docs) {
    summaries.push(summaryOf(doc, activeEntryCount(doc)));
    playerIds.add(doc.creatorId);
    if (doc.winnerId) playerIds.add(doc.winnerId);
  }
  // Resolve display names through the existing player-stats infrastructure.
  const { getPlayerStats } = await import("@/lib/server/hosted");
  const players: Record<string, string> = {};
  for (const id of playerIds) {
    const stats = await getPlayerStats(id);
    if (stats.username) players[id] = stats.username;
  }
  return { tournaments: summaries, players };
}

/**
 * Enrichment for the detail view: every tournament match gets live game
 * status straight from the hosted store (fen, moves, whose turn).
 */
export async function tournamentMatchesWithGames(
  doc: TournamentDocument,
): Promise<Map<string, GameState | null>> {
  const out = new Map<string, GameState | null>();
  for (const m of doc.matches) {
    if (!m.gameId) {
      out.set(m.id, null);
      continue;
    }
    out.set(m.id, await getHostedGame(m.gameId));
  }
  return out;
}
