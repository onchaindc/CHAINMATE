// Server-only module — never import from client components.

/**
 * Tournament economy service — ChainMate Phase 2B.
 *
 * Paid tournament entries, built directly on the Phase 1C verification
 * engine. The money path is exactly:
 *
 *   client sends txHash → server loads the tournament → the TOURNAMENT
 *   RECORD defines the exact fee and treasury recipient →
 *   verifyIncomingTransaction() verifies the real on-chain tx (sender =
 *   player's Phase-1B linked wallet, recipient = treasury, value = fee,
 *   confirmations, replay) → only then is the entry marked paid and the
 *   consumption recorded with kind='tournament_entry'.
 *
 * The client is authoritative for NOTHING: not the amount, not the
 * recipient, not the player, not the tournament. The same tx hash can never
 * create two entries (1C replay guard + unique ledger index), a player can
 * hold only one paid entry per tournament, and one payment can never be
 * attached to two tournaments.
 *
 * Prize pool = the sum of verified kind='tournament_entry' consumptions for
 * the tournament — never a client number, never a configured number.
 */

import type { NimiqNetworkName } from "@/lib/nimiq/config";
import { NIMIQ_NETWORK } from "@/lib/nimiq/config";
import { isPaidEntryFee, lunaFromStored } from "@/lib/tournament-economy";
import {
  NimiqTxError,
  fastStoreTxStore,
  verifyIncomingTransaction,
  type NimiqTxStore,
  type VerifyDeps,
  type VerifiedNimiqTransaction,
} from "@/lib/server/nimiq/transactions";
import type { PaidEntryState } from "@/lib/server/tournament-economy-doc";

/** One verified, paid entry in the ledger. */
export interface PaidTournamentEntry {
  playerId: string;
  txHash: string;
  network: NimiqNetworkName;
  amountLuna: bigint;
  verifiedAt: number;
}

/** Typed failure for the entry-payment flow, mapped to HTTP statuses. */
export type TournamentEntryErrorKind =
  | "tournament-not-found"
  | "not-paid-tournament"
  | "registration-closed"
  | "already-joined"
  | "already-paid"
  | "tournament-full"
  | "tx-required"
  | "guest-rejected"
  | "verification-failed"
  | "seat-creation-failed";

const STATUS_BY_KIND: Record<TournamentEntryErrorKind, number> = {
  "tournament-not-found": 404,
  "not-paid-tournament": 400,
  "registration-closed": 409,
  "already-joined": 409,
  "already-paid": 409,
  "tournament-full": 409,
  "tx-required": 400,
  "guest-rejected": 403,
  "verification-failed": 502,
  "seat-creation-failed": 500,
};

export class TournamentEntryError extends Error {
  readonly kind: TournamentEntryErrorKind;
  readonly status: number;
  constructor(kind: TournamentEntryErrorKind, message: string) {
    super(message);
    this.name = "TournamentEntryError";
    this.kind = kind;
    this.status = STATUS_BY_KIND[kind];
  }
}

/**
 * The transaction WAS verified and consumed, but the paid seat could not be
 * created. Carries the consumed hash so the payment is always traceable and
 * a retry can self-heal (see joinPaidTournament's already-consumed path).
 */
export class SeatCreationError extends TournamentEntryError {
  /** The tx hash that was consumed WITHOUT producing a seat. Never null. */
  readonly consumedTxHash: string;
  constructor(message: string, consumedTxHash: string) {
    super("seat-creation-failed", message);
    this.name = "SeatCreationError";
    this.consumedTxHash = consumedTxHash;
  }
}

/** Minimal read view of the tournament document the engine already stores. */
interface TournamentEconomyDoc {
  id: string;
  status: string;
  creatorId: string;
  maxPlayers: number;
  entryFeeLuna: string | null;
  entries: Array<{ playerId: string; leftAt?: number; paid?: PaidEntryState }>;
}

/** Read seam so tests can fake tournament documents without the engine. */
export type TournamentDocReader = (
  tournamentId: string,
) => Promise<TournamentEconomyDoc | null>;

/** Deps for joinPaidTournament — all default to the real implementations. */
export interface JoinPaidDeps extends Pick<VerifyDeps, "rpc" | "store" | "getLinkedWallet"> {
  getTournamentDoc?: TournamentDocReader;
  /**
   * B1 ordering — RESERVE the seat BEFORE payment verification: create the
   * player's (unpaid) entry, or re-activate a withdrawn one, inside the
   * engine's tournament lock. Throws TournamentEntryError when the seat is
   * impossible (full, already paid) so verification/consumption never runs
   * for a join that cannot succeed. Defaults to the real engine writer.
   * Returns whether a NEW entry was created (drives release). Tests may
   * fake it — the integration test does not.
   */
  reserveSeat?: (tournamentId: string, playerId: string) => Promise<{ created: boolean }>;
  /**
   * Marks the player's reserved entry paid inside the engine's tournament
   * lock (defaults to the real engine writer). Tests may fake it.
   */
  markEntryPaid?: (tournamentId: string, playerId: string, txHash: string) => Promise<void>;
  /**
   * B1 ordering — RELEASE a reserved-but-unpaid seat after a FAILED
   * verification (only when the flow created it), restoring the exact
   * pre-call state. Defaults to the real engine writer.
   */
  releaseSeat?: (tournamentId: string, playerId: string, created: boolean) => Promise<void>;
  /** Account gate (H2): resolves true when the player is a GUEST account. */
  isGuestAccount?: (playerId: string) => Promise<boolean>;
  now?: () => number;
}

/**
 * Serializes the WHOLE paid-join flow per (tournament, player) — the same
 * promise-chain idiom as the engine's document lock. This closes the last
 * double-spend race: two concurrent joins by the SAME player with DIFFERENT
 * transactions can no longer both verify (the second sees the paid seat in
 * its pre-check before it ever verifies its tx).
 */
const paidJoinLocks = new Map<string, Promise<unknown>>();

async function withPaidJoinLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = paidJoinLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  paidJoinLocks.set(key, run.catch(() => undefined));
  return run;
}

/**
 * H2 — is this player a guest (no account profile)?
 *
 * Fail-closed: when the profile store cannot answer (unconfigured Supabase or
 * a lookup error resolves to null), the player is treated as a guest. A real
 * authenticated account ALWAYS has a profile row, so this can only deny a
 * legitimate paid entry during a Supabase outage — never let a guest pay.
 */
export async function isGuestAccount(playerId: string): Promise<boolean> {
  const { profileForPlayerId } = await import("@/lib/supabase/db");
  const profile = await profileForPlayerId(playerId).catch(() => null);
  return profile?.is_guest !== false;
}

/**
 * H2 — server-side gate for PAID tournaments (shared by the plain join route
 * and the paid-entry flow). Guests may play free tournaments only.
 */
export async function requireAccountForPaidTournament(
  doc: { entryFeeLuna?: string | null } | null,
  playerId: string,
  isGuest: (pid: string) => Promise<boolean> = isGuestAccount,
): Promise<void> {
  if (!doc) return; // not-found handled by the caller's own flow
  const feeLuna = doc.entryFeeLuna ? lunaFromStored(doc.entryFeeLuna) : 0n;
  if (!isPaidEntryFee(feeLuna)) return; // free: guests welcome
  if (await isGuest(playerId)) {
    throw new TournamentEntryError(
      "guest-rejected",
      "Paid tournaments require a ChainMate account — sign in and link a wallet to enter",
    );
  }
}

/**
 * Pay to join a PAID tournament.
 *
 * Contract: the tournament record is the only source of the fee and the
 * recipient; the client contributes only the txHash of a transfer it
 * initiated to the treasury for the displayed fee. Verification, replay
 * protection, and persistence all happen through Phase 1C.
 */
export async function joinPaidTournament(
  tournamentId: string,
  playerId: string,
  txHashInput: string,
  deps: JoinPaidDeps = {},
): Promise<{ entry: PaidTournamentEntry; txHash: string }> {
  if (!txHashInput || typeof txHashInput !== "string" || txHashInput.trim() === "") {
    throw new TournamentEntryError("tx-required", "A transaction hash is required to join a paid tournament");
  }

  const readDoc =
    deps.getTournamentDoc ??
    (async (id: string) => {
      const { getTournamentDoc } = await import("@/lib/server/tournament-store");
      return (await getTournamentDoc(id)) as unknown as TournamentEconomyDoc | null;
    });

  const doc = await readDoc(tournamentId);
  if (!doc) {
    throw new TournamentEntryError("tournament-not-found", "Tournament not found");
  }

  const feeLuna = doc.entryFeeLuna ? lunaFromStored(doc.entryFeeLuna) : 0n;
  if (!isPaidEntryFee(feeLuna)) {
    throw new TournamentEntryError(
      "not-paid-tournament",
      "This tournament is free to enter — join it without a payment",
    );
  }

  if (doc.status !== "registration") {
    throw new TournamentEntryError(
      "registration-closed",
      doc.status === "draft"
        ? "Registration has not opened yet"
        : `Registration is closed (tournament is ${doc.status.replace("_", " ")})`,
    );
  }

  return withPaidJoinLock(`join:${tournamentId}:${playerId}`, async () => {
    // Re-read INSIDE the lock (the pre-lock read only answered "is this a
    // paid tournament at all" and derived the fee).
    const docNow = (await readDoc(tournamentId)) as TournamentEconomyDoc | null;
    if (!docNow) {
      throw new TournamentEntryError("tournament-not-found", "Tournament not found");
    }
    const active = docNow.entries.filter((e) => e.leftAt === undefined);
    const myEntry = docNow.entries.find((e) => e.playerId === playerId);
    if (myEntry && myEntry.leftAt === undefined && myEntry.paid) {
      // Exact-same-payment retry (client retry after a lost response, or
      // the crash-recovery path): idempotent no-op success — the seat
      // exists and THIS tx already paid for it. A DIFFERENT tx never attaches.
      if (myEntry.paid.txHash === txHashInput.trim().toLowerCase()) {
        return {
          txHash: myEntry.paid.txHash,
          entry: {
            playerId,
            txHash: myEntry.paid.txHash,
            network: NIMIQ_NETWORK,
            amountLuna: feeLuna,
            verifiedAt: myEntry.paid.paidAt,
          },
        };
      }
      throw new TournamentEntryError("already-paid", "You have already paid to join this tournament");
    }
    // An ACTIVE but UNPAID seat is not a duplicate-join error — paying now
    // IS the join. The seat-writer below marks that entry paid.
    if (active.length >= docNow.maxPlayers && !myEntry) {
      throw new TournamentEntryError("tournament-full", "The tournament is full");
    }

    // H2: guests can never enter a PAID tournament — enforced BEFORE the
    // seat is reserved, before verification, before any consumption.
    if (await (deps.isGuestAccount ?? isGuestAccount)(playerId)) {
      throw new TournamentEntryError(
        "guest-rejected",
        "Paid tournaments require a ChainMate account — sign in and link a wallet to enter",
      );
    }

    // ------------------------------------------------------------
    // B1 ORDERING: RESERVE the seat FIRST (under the engine's lock).
    // A paid seat that cannot exist means verification must not run and
    // money must not move. reserveSeat re-throws the business rejections.
    // ------------------------------------------------------------
    const reserve = deps.reserveSeat ?? reserveSeatInEngine;
    const { created } = await reserve(tournamentId, playerId);

    // The durable replay guard first: has THIS tx already paid for anything?
    const store: NimiqTxStore = deps.store ?? fastStoreTxStore;
  const network: NimiqNetworkName = NIMIQ_NETWORK;

  // Verify + consume through Phase 1C. Tournament context rides on the
  // obligation so the consumption row records kind='tournament_entry' and
  // the tournament id in one atomic write.
  let verified: VerifiedNimiqTransaction;
  try {
    verified = await verifyIncomingTransaction(
      txHashInput,
      {
        playerId,
        expectedAmountLuna: feeLuna,
        kind: "tournament_entry",
        tournamentId,
        network,
      },
      { rpc: deps.rpc, store, getLinkedWallet: deps.getLinkedWallet },
    );
  } catch (err) {
    // Verification failed: release ONLY a seat this flow created, so a
    // failed payment never leaves a phantom seat occupying a slot. A seat
    // the player already held (re-join) is left as it was.
    const release = deps.releaseSeat ?? releaseSeatInEngine;
    await release(tournamentId, playerId, created).catch(() => undefined);
    if (err instanceof NimiqTxError && err.kind === "already-consumed") {
      // B1 self-heal: if this exact tx was already consumed BY THIS PLAYER
      // FOR THIS TOURNAMENT (a crash between consumption and seat marking),
      // completing the seat is the correct, idempotent recovery — the money
      // is already committed to this tournament. (The release above is a
      // no-op in the only states where this row can exist.)
      const existing = await store
        .findByNetworkAndHash(network, txHashInput.trim().toLowerCase())
        .catch(() => null);
      if (
        existing &&
        existing.playerId === playerId &&
        existing.tournamentId === tournamentId &&
        existing.kind === "tournament_entry"
      ) {
        const mark = deps.markEntryPaid ?? ensurePaidSeatInEngine;
        await mark(tournamentId, playerId, existing.txHash);
        return {
          txHash: existing.txHash,
          entry: {
            playerId,
            txHash: existing.txHash,
            network: existing.network as NimiqNetworkName,
            amountLuna: BigInt(existing.amountLuna),
            verifiedAt: existing.verifiedAt,
          },
        };
      }
      // Consumed by someone/somewhere else — never double-spend it here.
      throw new TournamentEntryError("already-paid", err.message);
    }
    if (err instanceof NimiqTxError) {
      // Surface verification failures with their precise, retryable meaning.
      throw new TournamentEntryError("verification-failed", err.message);
    }
    throw err;
  }

  // B1 — the seat write is the final, authoritative step and it runs INSIDE
  // the engine's per-tournament lock. The REAL writer (ensurePaidSeatInEngine)
  // creates the entry when missing — a verified payment can no longer
  // evaporate against a silently-no-op helper. If the seat still cannot be
  // created (tournament vanished, or the field filled between the pre-check
  // and the lock), the error carries the consumed hash loudly instead of
  // pretending the join succeeded.
  const mark = deps.markEntryPaid ?? ensurePaidSeatInEngine;
  try {
    await mark(tournamentId, playerId, verified.txHash);
  } catch (err) {
    if (err instanceof TournamentEntryError) throw err;
    throw new SeatCreationError(
      `Payment was verified and consumed (${verified.txHash.slice(0, 10)}…) but the tournament seat could not be created: ${
        err instanceof Error ? err.message : String(err)
      }`,
      verified.txHash,
    );
  }

  return {
    txHash: verified.txHash,
    entry: {
      playerId,
      txHash: verified.txHash,
      network: verified.network,
      amountLuna: BigInt(verified.amountLuna),
      verifiedAt: verified.verifiedAt,
    },
  };
  });
}

/**
 * B1 — RESERVE: create the player's (unpaid) entry inside the engine's
 * per-tournament lock, or re-activate a withdrawn one. Throws the business
 * rejections (full / already paid / tournament gone) BEFORE any money moves.
 * Returns whether a NEW entry row was created (drives release-on-failure).
 */
async function reserveSeatInEngine(
  tournamentId: string,
  playerId: string,
): Promise<{ created: boolean }> {
  const { getTournamentDoc, withTournamentLock, writeTournamentDoc } =
    await import("@/lib/server/tournament-store");
  return withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) {
      throw new TournamentEntryError(
        "tournament-not-found",
        "Tournament disappeared before the seat could be reserved",
      );
    }
    const entry = doc.entries.find((e) => e.playerId === playerId);
    if (entry) {
      if (entry.leftAt === undefined && entry.paid) {
        throw new TournamentEntryError(
          "already-paid",
          "You have already paid to join this tournament",
        );
      }
      // Unpaid active seat: reuse it. Withdrawn seat: re-join semantics.
      entry.leftAt = undefined;
      await writeTournamentDoc(doc);
      return { created: false };
    }
    if (doc.entries.filter((e) => e.leftAt === undefined).length >= doc.maxPlayers) {
      throw new TournamentEntryError("tournament-full", "The tournament is full");
    }
    doc.entries.push({ playerId, joinedAt: Date.now() });
    await writeTournamentDoc(doc);
    return { created: true };
  });
}

/**
 * B1 — RELEASE: undo a reservation this flow created when verification
 * fails (restores the exact pre-call state; a no-op for a seat the player
 * already held). Runs inside the engine's per-tournament lock.
 */
async function releaseSeatInEngine(
  tournamentId: string,
  playerId: string,
  created: boolean,
): Promise<void> {
  if (!created) return;
  const { getTournamentDoc, withTournamentLock, writeTournamentDoc } =
    await import("@/lib/server/tournament-store");
  await withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return;
    const entry = doc.entries.find((e) => e.playerId === playerId);
    if (!entry) return;
    if (entry.paid) return; // paid meanwhile — never release a paid seat
    doc.entries = doc.entries.filter((e) => e.playerId !== playerId);
    await writeTournamentDoc(doc);
  });
}

/**
 * B1 — the REAL seat writer: create-or-mark the player's entry paid inside
 * the engine's per-tournament lock, then persist the document.
 *
 * Re-throws TournamentEntryError for the expected business rejections (a
 * racing already-paid seat, a field that filled up) so joinPaidTournament can
 * surface them precisely; anything else escapes to become a SeatCreationError.
 */
async function ensurePaidSeatInEngine(
  tournamentId: string,
  playerId: string,
  txHash: string,
): Promise<void> {
  const [{ getTournamentDoc, withTournamentLock, writeTournamentDoc }] =
    await Promise.all([
      import("@/lib/server/tournament-store"),
      import("@/lib/server/tournament-economy-doc"),
    ]);
  await withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) {
      throw new Error("Tournament disappeared before the paid seat could be created");
    }
    const paidState: PaidEntryState = { txHash: txHash.toLowerCase(), paidAt: Date.now() };
    const entry = doc.entries.find((e) => e.playerId === playerId);
    if (entry) {
      if (entry.leftAt === undefined && entry.paid) {
        // Same tx already applied (concurrent identical retry won the race):
        // idempotent no-op success. A DIFFERENT tx can never attach.
        if (entry.paid.txHash === txHash.toLowerCase()) return;
        throw new TournamentEntryError(
          "already-paid",
          "You have already paid to join this tournament",
        );
      }
      // Unpaid active seat: mark it paid. Withdrawn seat: re-join semantics
      // (the engine's join flow reuses left entries the same way).
      entry.leftAt = undefined;
      entry.paid = paidState;
    } else {
      if (doc.entries.filter((e) => e.leftAt === undefined).length >= doc.maxPlayers) {
        throw new TournamentEntryError(
          "tournament-full",
          "The tournament filled up before your payment could be applied",
        );
      }
      doc.entries.push({ playerId, joinedAt: Date.now(), paid: paidState });
    }
    await writeTournamentDoc(doc);
  });
}

/**
 * The verified prize pool for a tournament: the exact sum of every
 * kind='tournament_entry' consumption recorded against it. Never trusts any
 * other number.
 */
export async function getVerifiedPrizePool(
  tournamentId: string,
  store: NimiqTxStore = fastStoreTxStore,
): Promise<bigint> {
  if (!store.listByTournament) return 0n;
  const rows = await store.listByTournament(tournamentId);
  return rows
    .filter((r) => r.kind === "tournament_entry")
    .reduce((acc, r) => acc + BigInt(r.amountLuna), 0n);
}

/** Verified paid entries for a tournament (newest last). */
export async function listPaidEntries(
  tournamentId: string,
  store: NimiqTxStore = fastStoreTxStore,
): Promise<PaidTournamentEntry[]> {
  if (!store.listByTournament) return [];
  const rows = await store.listByTournament(tournamentId);
  return rows
    .filter((r) => r.kind === "tournament_entry")
    .map((r) => ({
      playerId: r.playerId,
      txHash: r.txHash,
      network: r.network,
      amountLuna: BigInt(r.amountLuna),
      verifiedAt: r.verifiedAt,
    }))
    .sort((a, b) => a.verifiedAt - b.verifiedAt);
}

/** Deps for the start-time assertion (seams for tests). */
export interface AssertPaidDeps {
  store?: NimiqTxStore;
  getTournamentDoc?: TournamentDocReader;
}

/**
 * Assert (for the engine) that every active entry in a PAID tournament is
 * actually paid before the event can start. Throws TournamentEntryError.
 */
export async function assertAllEntriesPaid(
  tournamentId: string,
  deps: AssertPaidDeps = {},
): Promise<void> {
  const store = deps.store ?? fastStoreTxStore;
  const readDoc =
    deps.getTournamentDoc ??
    (async (id: string) => {
      const { getTournamentDoc } = await import("@/lib/server/tournament-store");
      return (await getTournamentDoc(id)) as unknown as TournamentEconomyDoc | null;
    });
  const doc = await readDoc(tournamentId);
  if (!doc) throw new TournamentEntryError("tournament-not-found", "Tournament not found");
  const feeLuna = doc.entryFeeLuna ? lunaFromStored(doc.entryFeeLuna) : 0n;
  if (!isPaidEntryFee(feeLuna)) return; // free tournament: nothing to assert

  const paidPlayerIds = new Set((await listPaidEntries(tournamentId, store)).map((p) => p.playerId));
  const unpaid = doc.entries
    .filter((e) => e.leftAt === undefined)
    .filter((e) => !paidPlayerIds.has(e.playerId));
  if (unpaid.length > 0) {
    throw new TournamentEntryError(
      "verification-failed",
      `${unpaid.length} player(s) have not completed their entry payment yet`,
    );
  }
}
