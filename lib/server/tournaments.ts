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
import { isPaidEntryFee, lunaFromStored, validateEntryFee } from "@/lib/tournament-economy";
import { getHostedGame } from "@/lib/server/hosted";
import { isGameOver, type GameStatus, type GameState } from "@/lib/types";
import {
  requireNotBanned,
  isAdminPlayer,
} from "@/lib/server/admin";
import { getLinkedWallet } from "@/lib/server/nimiq/service";
import { getAccountByAddress } from "@/lib/server/nimiq/rpc";
import { NIMIQ_NETWORK } from "@/lib/nimiq/config";
import { LUNA_PER_NIM, NimiqMoneyError } from "@/lib/nimiq/format";

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
 * Minimum LINKED-wallet balance to HOST any tournament (free or paid).
 * Cheap enough to never block a genuine player; high enough that a
 * drive-by spammer burns 50 real NIM of wallet to flood the list.
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
      const account = await getAccountByAddress(linked.address, { timeoutMs: 10_000 });
      if (!account) {
        return {
          ok: false,
          error: "We could not read your wallet balance from the Nimiq node right now. Try again in a moment.",
        };
      }
      balance =
        typeof account.balance === "string"
          ? BigInt(account.balance)
          : BigInt(Math.trunc(Number(account.balance)));
    }
    if (balance < BigInt(CREATOR_MIN_NIM) * LUNA_PER_NIM) {
      return {
        ok: false,
        error: `Hosting a tournament requires at least ${CREATOR_MIN_NIM} NIM in your linked wallet. Your balance is too low.`,
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
    startedAt: null,
    completedAt: null,
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
export async function transitionTournament(
  tournamentId: string,
  actorId: string,
  to: TournamentStatus,
): Promise<TransitionResult> {
  return withTournamentLock(tournamentId, () =>
    transitionTournamentInner(tournamentId, actorId, to),
  );
}

async function transitionTournamentInner(
  tournamentId: string,
  actorId: string,
  to: TournamentStatus,
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
    if (activeEntryCount(doc) < 2) {
      return { ok: false, error: "Need at least 2 players to start" };
    }
    // Phase 2B: a PAID tournament cannot start with unpaid entries.
    if (isPaidTournamentDoc(doc)) {
      const { assertAllEntriesPaid } = await import("@/lib/server/tournament-economy");
      try {
        await assertAllEntriesPaid(doc.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "entry payment check failed";
        return { ok: false, error: `Cannot start yet — ${message}` };
      }
    }
    const won = await transitionTournamentStatus(doc.id, doc.status, "in_progress");
    if (!won) return { ok: false, error: "The tournament was already started elsewhere" };

    doc.status = "in_progress";
    doc.startedAt = Date.now();
    doc.totalRounds = totalRoundsFor(doc, activeEntryCount(doc));
    doc.currentRound = 0;
    doc.standings = recomputeStandings(doc);
    await writeTournamentDoc(doc);

    // First round generation is part of the start transition for formats
    // that need one (knockout always, swiss round 1). Arena pairs on demand.
    // Inner variant: we are already inside the document lock.
    await ensureNextRoundInner(doc.id).catch(() => {});
    return { ok: true, doc };
  }

  if (to === "completed") {
    const won = await transitionTournamentStatus(doc.id, doc.status, "completed");
    if (!won) return { ok: false, error: "The tournament was already completed elsewhere" };
    doc.status = "completed";
    doc.completedAt = Date.now();
    await writeTournamentDoc(doc);
    // Phase 2B: a PAID tournament now materialises its payout records from
    // the verified ledger + final standings. Best-effort: completion itself
    // must succeed even if payout planning fails (it can be re-run).
    if (isPaidTournamentDoc(doc) && doc.prizePreset) {
      try {
        const [{ planTournamentPayouts }, { getVerifiedPrizePool, listPaidEntries }] =
          await Promise.all([
            import("@/lib/server/tournament-payouts"),
            import("@/lib/server/tournament-economy"),
          ]);
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
        if ("created" in result && result.created > 0) {
          doc.payoutStatus = "pending";
          await writeTournamentDoc(doc);
        }
      } catch {
        // Payout planning can be re-run by the host; completion stands.
      }
    }
    return { ok: true, doc };
  }

  if (to === "cancelled") {
    const won = await transitionTournamentStatus(doc.id, doc.status, "cancelled");
    if (!won) return { ok: false, error: "The tournament was already closed elsewhere" };
    doc.status = "cancelled";
    // Phase 2B: cancelling a PAID tournament that has verified entries
    // requires refunds ChainMate cannot send — record it durably instead of
    // pretending the money was returned.
    if (isPaidTournamentDoc(doc)) {
      try {
        const { listPaidEntries } = await import("@/lib/server/tournament-economy");
        if ((await listPaidEntries(doc.id)).length > 0) {
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

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/** Entries that are actually in the event (not withdrawn). */
function activeEntries(doc: TournamentDocument): TournamentEntry[] {
  return doc.entries.filter((e) => e.leftAt === undefined);
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
    return { ok: false, error: "Registration has closed — the tournament is running" };
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
    return { ok: false, error: "The tournament is running — leaving mid-event is not supported in this phase" };
  }
  if (isTournamentTerminal(doc.status)) {
    return { ok: false, error: `Tournament is ${doc.status}` };
  }
  const entry = doc.entries.find((e) => e.playerId === playerId);
  if (!entry || entry.leftAt !== undefined) {
    return { ok: false, error: "You are not registered in this tournament" };
  }
  // Phase 2B: a player leaving a PAID tournament during registration is a
  // refund question — ChainMate has no refund mechanism, so the entry is
  // flagged refund_required on the tournament and the payment stays recorded
  // in the ledger (it still counts toward the prize pool — it was real).
  if (isPaidTournamentDoc(doc) && entry.paid) {
    doc.payoutStatus = "refund_required";
  }
  entry.leftAt = Date.now();
  await writeTournamentDoc(doc);
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
            "This tournament has paid entries — only a ChainMate administrator can delete it",
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
          ? "The tournament is running — end or cancel it instead"
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

/** Players with no unfinished match this round/window. */
function idlePlayers(doc: TournamentDocument, playerIds: string[]): string[] {
  return playerIds.filter((id) => !activeGameFor(doc, id));
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
  const { createHostedGame, joinHostedGame } = await import("@/lib/server/hosted");
  const game = await createHostedGame(white, {
    timeControl: doc.timeControl,
    visibility: "public",
  });
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
  if (order.length % 2 === 1) {
    const paired = new Set(pairs.flat());
    const bye = order.find((id) => !paired.has(id));
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
    return { ok: false, error: "No opponent is free right now — try again in a moment" };
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
  // Aborted games never happened: the match is voided, no standings impact.
  if (status === "aborted") {
    match.status = "complete";
    match.resultReason = "aborted";
    match.completedAt = Date.now();
  } else if (!game.winner) {
    // Draw: checkmate-less terminal with no winner (stalemate, agreement,
    // repetition…). All existing draw-ish terminal states land here.
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
    if (roundMatches.length === 0 || roundMatches.some((m) => m.status !== "complete")) {
      return; // round still running
    }
    const winners = roundMatches.map((m) =>
      m.result === "white" ? m.whitePlayerId : m.blackPlayerId,
    );
    if (winners.length === 1) {
      await completeTournamentInner(tournamentId, winners[0]);
      return;
    }
    // Every match in the round is done — build the next one. Byes can make
    // winners.length odd: an odd winner gets a free pass (documented).
    await ensureNextRoundInner(tournamentId);
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
    await ensureNextRoundInner(tournamentId);
  }
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
async function openDueTournaments(): Promise<void> {
  let docs: TournamentDocument[];
  try {
    docs = await listTournamentDocs({ status: "draft", limit: 50 });
  } catch {
    return; // reads must never fail because of the scheduler
  }
  const now = Date.now();
  for (const doc of docs) {
    if (doc.scheduledStartAt == null || doc.scheduledStartAt > now) continue;
    // Lock under the per-document lock; a host opening it manually first
    // simply makes this a no-op.
    try {
      await withTournamentLock(doc.id, async () => {
        const fresh = await getTournamentDoc(doc.id);
        if (!fresh || fresh.status !== "draft") return;
        if (fresh.scheduledStartAt == null || fresh.scheduledStartAt > Date.now()) return;
        const won = await transitionTournamentStatus(fresh.id, fresh.status, "registration");
        if (!won) return;
        fresh.status = "registration";
        await writeTournamentDoc(fresh);
      });
    } catch {
      // One bad tournament must not block the rest of the list.
    }
  }
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
        label: roundLabel(r, doc.totalRounds || r),
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

  return {
    summary,
    entries: entrants,
    rounds,
    standings: doc.standings.length > 0 ? doc.standings : recomputeStandings(doc),
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
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    createdAt: doc.createdAt,
    currentRound: doc.format === "arena" ? undefined : doc.currentRound || undefined,
    totalRounds: doc.format === "arena" ? undefined : doc.totalRounds || undefined,
    winnerId: doc.winnerId,
    // Phase 2B economy fields (additive; older clients ignore them).
    entryFeeLuna: doc.entryFeeLuna ?? null,
    prizePreset: doc.prizePreset ?? null,
    payoutStatus: doc.payoutStatus ?? "none",
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
