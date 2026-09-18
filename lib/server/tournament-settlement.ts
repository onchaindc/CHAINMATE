// Server-only module — never import from client components.

/**
 * Tournament settlement — the completion engine for PAID events.
 *
 * A completed tournament does not end at "standings frozen". Paid events owe
 * real money, and owed money needs a driver. This module IS that driver: it
 * walks the payout ledger and the refund ledger forward, one idempotent step
 * at a time, until every obligation is either verified on-chain or durably
 * recorded as needing operator attention (no wallet linked). Every step is
 * safe to run twice, from two instances at once, or after a crash — the
 * write-ahead protocols in tournament-payouts(-dispatch) guarantee exactly
 * one effective on-chain movement per obligation.
 *
 * Money in this module is REAL or RECORD ONLY: nothing is faked. When no
 * treasury signer is configured, dispatch is skipped (leaving durable
 * pending/owed rows) and NEVER simulated as success.
 *
 * driven by runTournamentMaintenance (polls + POST /api/tournaments/maintenance).
 */

import type { RefundRecord, TournamentDocument } from "@/lib/server/tournament-store";
import { getTournamentDoc, writeTournamentDoc, withTournamentLock } from "@/lib/server/tournament-store";
import {
  fastStorePayoutStore,
  type PayoutRecord,
  type PayoutStore,
  type TreasurySigner,
} from "@/lib/server/tournament-payouts";
import {
  buildRpcTreasurySigner,
  dispatchPayout,
  verifyOutgoingPayout,
} from "@/lib/server/tournament-payouts-dispatch";
import { mirrorRefund } from "@/lib/server/tournament-store";

/* ------------------------------------------------------------------ */
/* Refund dispatch                                                     */
/* ------------------------------------------------------------------ */

/**
 * Broadcast one owed refund through the treasury signer, using the same
 * write-ahead discipline as prize payouts: record the intent (dispatched +
 * vsh) BEFORE the broadcast, then persist the real hash. A crash anywhere
 * leaves a durable row that a retry resolves to exactly one return.
 *
 * CRASH RECOVERY: a refund that is 'dispatched' but has no hash may have
 * broadcast (hash lost) or not. The signer interface re-broadcasts with the
 * SAME recorded validityStartHeight whenever present — Nimiq transactions
 * are a pure function of their fields, so the retry is byte-identical and
 * the chain dedupes: exactly one effective refund either way.
 *
 * The signer defaults to the deployment's real payout-node signer and may
 * be injected (tests, tooling). With NO signer the obligation stays durably
 * owed — this module never simulates money movement.
 */
export async function dispatchRefund(
  tournamentId: string,
  playerId: string,
  deps: { signer?: TreasurySigner | null } = {},
): Promise<RefundRecord | null> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc?.refunds?.[playerId]) return null;
  const refund = doc.refunds[playerId];
  if (refund.status === "verified") return refund; // idempotent
  if (refund.status === "dispatched" && refund.refundTxHash) {
    return refund; // already broadcast, waiting on verification
  }

  let signer = deps.signer;
  if (signer === undefined) {
    // Either the deployment's payout-node signer, or a signer another
    // module installed via configureTreasurySigner (ops tooling, tests).
    const { getConfiguredTreasurySigner } = await import("@/lib/server/tournament-payouts");
    signer = buildRpcTreasurySigner() ?? getConfiguredTreasurySigner();
  }
  if (!signer) return null; // no payout node: stays owed, never faked

  const destination = await refundDestinationFor(tournamentId, playerId);
  if (!destination) {
    const failed: RefundRecord = {
      ...refund,
      status: "failed",
      lastError: "Player has no linked Nimiq wallet to refund to",
      attempts: refund.attempts + 1,
    };
    await persistRefund(tournamentId, failed);
    return failed;
  }

  try {
    // Write-ahead intent (with the current chain height as the vsh) unless
    // an intent is already on file.
    if (refund.status !== "dispatched" || refund.validityStartHeight == null) {
      let height: number;
      try {
        height = await signer.getChainHeight!();
      } catch {
        return null; // node unreachable — try again on the next sweep
      }
      if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return null;
      const intent: RefundRecord = {
        ...refund,
        status: "dispatched",
        validityStartHeight: height,
        attempts: refund.attempts + 1,
      };
      await persistRefund(tournamentId, intent);
    }

    // Broadcast with the recorded vsh (byte-identical recovery) or a fresh
    // one when the intent somehow lacks it.
    let vsh = refund.validityStartHeight ?? null;
    if (vsh == null) {
      vsh = await signer.getChainHeight!();
    }
    const txHash = await signer.sendPayout(
      destination,
      BigInt(refund.amountLuna),
      vsh,
    );
    if (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error("Node returned no usable transaction hash");
    }
    const sent: RefundRecord = {
      ...refund,
      status: "dispatched",
      refundTxHash: txHash,
      validityStartHeight: refund.validityStartHeight ?? vsh,
    };
    await persistRefund(tournamentId, sent);
    return sent;
  } catch (err) {
    const failed: RefundRecord = {
      ...refund,
      status: "failed",
      lastError: err instanceof Error ? err.message : "Refund broadcast failed",
      attempts: refund.attempts + 1,
    };
    await persistRefund(tournamentId, failed);
    return failed;
  }
}

/**
 * Resolve the REAL refund destination: the player's Phase-1B linked wallet
 * (the same binding entry payments are verified against — never a
 * client-supplied address).
 */
async function refundDestinationFor(
  tournamentId: string,
  playerId: string,
): Promise<string | null> {
  try {
    const { getLinkedWallet } = await import("@/lib/server/nimiq/service");
    const wallet = await getLinkedWallet(playerId);
    return wallet?.address ?? null;
  } catch {
    return null;
  }
}

/** Persist a refund row under the tournament lock and mirror it. */
async function persistRefund(tournamentId: string, refund: RefundRecord): Promise<void> {
  await withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return;
    doc.refunds = doc.refunds ?? {};
    doc.refunds[refund.playerId] = refund;
    await writeTournamentDoc(doc);
  });
  await mirrorRefund(tournamentId, refund).catch(() => undefined);
}

/**
 * Confirm a dispatched refund on-chain (sender = treasury, recipient =
 * player's linked wallet, value exact, executed, confirmed) and mark it
 * verified. Uses the payout verifier's primitives — the same fail-closed
 * field-by-field comparison, adapted to the refund record.
 */
export async function verifyRefund(
  tournamentId: string,
  playerId: string,
  deps: { getTransactionByHash?: typeof import("@/lib/server/nimiq/rpc").getTransactionByHash; getBlockNumber?: typeof import("@/lib/server/nimiq/rpc").getBlockNumber } = {},
): Promise<RefundRecord | null> {
  const doc = await getTournamentDoc(tournamentId);
  const refund = doc?.refunds?.[playerId];
  if (!refund) return null;
  if (refund.status === "verified") return refund; // idempotent
  if (refund.status !== "dispatched" || !refund.refundTxHash) return null;

  const { getNimiqPayoutConfig } = await import("@/lib/server/nimiq/payout-config");
  const rpc = await import("@/lib/server/nimiq/rpc");
  const { canonicalAddress } = await import("@/lib/server/nimiq/verify");
  const config = getNimiqPayoutConfig();
  if (!config) return null;

  const overrides = {
    url: config.url,
    basicAuth: config.basicAuth,
    apiKey: config.apiKey,
    timeoutMs: 10_000,
  };
  const fetchTx = deps.getTransactionByHash ?? rpc.getTransactionByHash;
  const heightOf = deps.getBlockNumber ?? rpc.getBlockNumber;

  let tx: Awaited<ReturnType<typeof rpc.getTransactionByHash>>;
  try {
    tx = await fetchTx(refund.refundTxHash, overrides);
  } catch {
    return null; // node hiccup: retry on the next sweep
  }
  if (!tx || typeof tx !== "object" || !tx.hash) return null;

  const destination = await refundDestinationFor(tournamentId, playerId);
  const sender = canonicalAddress(String(tx.from ?? ""));
  const expectedSender = canonicalAddress(config.treasuryAddress);
  const recipient = canonicalAddress(String(tx.to ?? ""));
  let onChainLuna = 0n;
  try {
    onChainLuna = BigInt(tx.value);
  } catch {
    onChainLuna = 0n;
  }
  const executionResult = (tx as { executionResult?: unknown }).executionResult;

  const mismatch =
    !expectedSender ||
    sender !== expectedSender ||
    !destination ||
    recipient !== canonicalAddress(destination) ||
    onChainLuna !== BigInt(refund.amountLuna) ||
    executionResult !== true ||
    typeof tx.blockNumber !== "number" ||
    tx.blockNumber < 0;
  if (mismatch) {
    // Not-yet-mined lands here too (blockNumber missing) — keep waiting.
    const notMined = executionResult === true && typeof tx.blockNumber !== "number";
    if (!notMined) {
      const failed: RefundRecord = {
        ...refund,
        status: "failed",
        lastError: "Refund transaction did not match the refund record on-chain",
      };
      await persistRefund(tournamentId, failed);
      return failed;
    }
    return null;
  }

  let height: number;
  try {
    height = await heightOf(overrides);
  } catch {
    return null;
  }
  const confirmationsRequired = config.confirmationsRequired ?? 10;
  if (height - (tx.blockNumber as number) + 1 < confirmationsRequired) return null; // still waiting

  const verified: RefundRecord = {
    ...refund,
    status: "verified",
    verifiedAt: Date.now(),
  };
  await persistRefund(tournamentId, verified);
  return verified;
}

/* ------------------------------------------------------------------ */
/* The settlement sweep for one tournament                             */
/* ------------------------------------------------------------------ */

export interface SettlementOutcome {
  payoutsDispatched: number;
  payoutsVerified: number;
  refundsDispatched: number;
  refundsVerified: number;
  /** True when every obligation is verified or durably blocked (no wallet). */
  settled: boolean;
}

/**
 * Advance ONE completed (or cancelled) paid tournament's settlement state as
 * far as configuration allows. Idempotent and concurrency-safe: each payout
 * dispatch serializes under its own lock in the payouts module; refund rows
 * are rewritten under the tournament lock with monotonic intent.
 *
 * Returns what happened so the caller (maintenance) can log honestly.
 */
export async function settleTournament(
  tournamentId: string,
  deps: { payoutStore?: PayoutStore; signer?: TreasurySigner | null } = {},
): Promise<SettlementOutcome> {
  const store = deps.payoutStore ?? fastStorePayoutStore;
  const signer = deps.signer;
  const outcome: SettlementOutcome = {
    payoutsDispatched: 0,
    payoutsVerified: 0,
    refundsDispatched: 0,
    refundsVerified: 0,
    settled: true,
  };

  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ...outcome, settled: true };

  const docPayoutStatus = doc.payoutStatus ?? "none";
  const isPaid = doc.entryFeeLuna != null && doc.entryFeeLuna !== "0";
  if (!isPaid) return { ...outcome, settled: true };

  /* ---- prize payouts (only once the event actually finished) ---- */
  if (doc.status === "completed") {
    const payouts = await store.listByTournament(tournamentId);
    for (const p of payouts) {
      if (p.status === "verified") continue;
      if (p.status === "blocked_no_wallet") {
        outcome.settled = false; // durably blocked: needs the winner to link
        continue;
      }
      if (p.status === "sent") {
        try {
          await verifyOutgoingPayout(tournamentId, p.playerId);
          outcome.payoutsVerified += 1;
        } catch {
          outcome.settled = false; // not enough confirmations / node down
        }
        continue;
      }
      // pending | failed | dispatching → dispatch (dispatching rows are
      // recovered inside dispatchPayout with the recorded vsh).
      try {
        const sent = await dispatchPayout(tournamentId, p.playerId);
        if (sent.status === "sent") {
          outcome.payoutsDispatched += 1;
          // Verify immediately when confirmations already exist (fast path);
          // otherwise the next sweep confirms.
          try {
            await verifyOutgoingPayout(tournamentId, p.playerId);
            outcome.payoutsVerified += 1;
          } catch {
            outcome.settled = false;
          }
        } else {
          outcome.settled = false; // failed → retried next sweep
        }
      } catch {
        outcome.settled = false; // signer unconfigured / node down / blocked
      }
    }
  }

  /* ---- refunds (cancelled events, leave-before-lock) ---- */
  if (doc.refunds) {
    for (const [playerId, refund] of Object.entries(doc.refunds)) {
      if (refund.status === "verified") continue;
      if (refund.status === "dispatched" && refund.refundTxHash) {
        const verified = await verifyRefund(tournamentId, playerId);
        if (verified?.status === "verified") outcome.refundsVerified += 1;
        else outcome.settled = false;
        continue;
      }
      const result = await dispatchRefund(tournamentId, playerId, { signer });
      if (result?.status === "dispatched" && result.refundTxHash) {
        outcome.refundsDispatched += 1;
        const verified = await verifyRefund(tournamentId, playerId);
        if (verified?.status === "verified") outcome.refundsVerified += 1;
        else outcome.settled = false;
      } else if (result?.status === "failed") {
        outcome.settled = false; // retried next sweep
      } else {
        outcome.settled = false; // no signer / unreachable: stays owed
      }
    }
  }

  /* ---- aggregate payoutStatus ---- */
  await refreshAggregatePayoutStatus(tournamentId, docPayoutStatus);
  return outcome;
}

/**
 * Recompute the document-level payout status from the ledgers: paid when
 * every payout is verified, partial when some are, pending while none are,
 * refunded when every refund is verified, refund_required while refunds
 * remain outstanding. Never downgrades a finished state.
 */
export async function refreshAggregatePayoutStatus(tournamentId: string, previous: string): Promise<void> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return;
  const status: "none" | "pending" | "partial" | "paid" | "refund_required" | "refunded" =
    doc.payoutStatus ?? "none";

  const refunds = doc.refunds ? Object.values(doc.refunds) : [];
  const refundOutstanding =
    refunds.length > 0 && refunds.some((r) => r.status !== "verified");

  let next = status;
  if (refundOutstanding) {
    next = "refund_required";
  } else if (refunds.length > 0) {
    next = "refunded";
  } else if (doc.status === "completed" && doc.entryFeeLuna && doc.entryFeeLuna !== "0") {
    const payouts = await fastStorePayoutStore.listByTournament(tournamentId);
    if (payouts.length > 0) {
      const verified = payouts.filter((p) => p.status === "verified").length;
      const blocked = payouts.filter((p) => p.status === "blocked_no_wallet").length;
      if (verified === payouts.length) next = "paid";
      else if (verified > 0) next = "partial";
      else next = "pending";
      void blocked;
    }
  }

  if (next !== status) {
    // Never downgrade past a completed aggregate state.
    const rank: Record<string, number> = {
      none: 0,
      pending: 1,
      refund_required: 2,
      partial: 3,
      paid: 4,
      refunded: 4,
    };
    if ((rank[next] ?? 0) >= (rank[status] ?? 0)) {
      doc.payoutStatus = next;
      await writeTournamentDoc(doc);
    }
  }
  void previous;
}

/* ------------------------------------------------------------------ */
/* Maintenance hook                                                    */
/* ------------------------------------------------------------------ */

/** Cap per sweep so one event with a dead RPC cannot stall the queue. */
const MAX_SETTLE_PER_SWEEP = 25;

/**
 * Settle every terminal paid tournament the fast store knows about. Called
 * from runTournamentMaintenance. Failures are per-tournament: one broken
 * event never blocks the rest.
 */
export async function runSettlementSweep(limit = MAX_SETTLE_PER_SWEEP): Promise<number> {
  const { listTournamentDocs } = await import("@/lib/server/tournament-store");
  let docs: TournamentDocument[];
  try {
    docs = await listTournamentDocs({ limit: 200 });
  } catch {
    return 0;
  }
  const candidates = docs.filter(
    (d) =>
      (d.status === "completed" || d.status === "cancelled") &&
      d.entryFeeLuna != null &&
      d.entryFeeLuna !== "0",
  );
  let touched = 0;
  for (const doc of candidates.slice(0, limit)) {
    try {
      const outcome = await settleTournament(doc.id);
      if (
        outcome.payoutsDispatched +
          outcome.payoutsVerified +
          outcome.refundsDispatched +
          outcome.refundsVerified >
        0
      ) {
        touched += 1;
      }
    } catch {
      // next sweep picks it up
    }
  }
  return touched;
}

export type { PayoutRecord };
