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
  | "verification-failed";

const STATUS_BY_KIND: Record<TournamentEntryErrorKind, number> = {
  "tournament-not-found": 404,
  "not-paid-tournament": 400,
  "registration-closed": 409,
  "already-joined": 409,
  "already-paid": 409,
  "tournament-full": 409,
  "tx-required": 400,
  "verification-failed": 502,
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

/** Minimal read view of the tournament document the engine already stores. */
interface TournamentEconomyDoc {
  id: string;
  status: string;
  creatorId: string;
  maxPlayers: number;
  entryFeeLuna: string | null;
  entries: Array<{ playerId: string; leftAt?: number }>;
}

/** Read seam so tests can fake tournament documents without the engine. */
export type TournamentDocReader = (
  tournamentId: string,
) => Promise<TournamentEconomyDoc | null>;

/** Deps for joinPaidTournament — all default to the real implementations. */
export interface JoinPaidDeps extends Pick<VerifyDeps, "rpc" | "store" | "getLinkedWallet"> {
  getTournamentDoc?: TournamentDocReader;
  /** Marks the player's tournament entry paid (defaults to the engine helper). */
  markEntryPaid?: (tournamentId: string, playerId: string, txHash: string) => Promise<void>;
  now?: () => number;
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

  const active = doc.entries.filter((e) => e.leftAt === undefined);
  if (doc.entries.some((e) => e.playerId === playerId && e.leftAt === undefined)) {
    throw new TournamentEntryError("already-joined", "You have already joined this tournament");
  }
  if (active.length >= doc.maxPlayers) {
    throw new TournamentEntryError("tournament-full", "The tournament is full");
  }

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
    if (err instanceof NimiqTxError) {
      // Surface verification failures with their precise, retryable meaning.
      throw new TournamentEntryError(
        err.kind === "already-consumed" ? "already-paid" : "verification-failed",
        err.message,
      );
    }
    throw err;
  }

  // Mark the tournament entry paid inside the engine's document lock. This
  // runs AFTER verification: an unpaid player is never in the field, and the
  // unique (tournament, player) ledger index means a second payment for the
  // same tournament+player cannot exist.
  const mark = deps.markEntryPaid ?? markEntryPaidInEngine;
  await mark(tournamentId, playerId, verified.txHash);

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
}

/** Flip the entry record to paid inside the engine's per-tournament lock. */
async function markEntryPaidInEngine(
  tournamentId: string,
  playerId: string,
  txHash: string,
): Promise<void> {
  const [{ getTournamentDoc, withTournamentLock, writeTournamentDoc }, economy] =
    await Promise.all([import("@/lib/server/tournament-store"), import("@/lib/server/tournament-economy-doc")]);
  await withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return;
    const entry = doc.entries.find((e) => e.playerId === playerId);
    if (entry) {
      economy.markEntryPaid(doc, playerId, txHash);
      await writeTournamentDoc(doc);
    } else {
      // Entry row missing (e.g. joined concurrently and left): record paid
      // state in the durable entry ledger via the economy doc helper anyway.
      economy.markEntryPaid(doc, playerId, txHash);
      await writeTournamentDoc(doc);
    }
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
