// Server-only module — never import from client components.

/**
 * Host-wallet refund settlement — returning entry fees when the deployment
 * has no signing node.
 *
 * Cancellation (and leave-before-lock) materialise durable refund
 * obligations, but the automatic settlement sweep can only BROADCAST them
 * through a treasury signer. This deployment's payout endpoint is read-only,
 * so without this module every refund would stay "owed" forever — the same
 * deadlock prizes had. The fix mirrors the prize path exactly: the HOST pays
 * each refund from their own Nimiq Pay wallet and ChainMate verifies that
 * real on-chain transaction against the refund record.
 *
 * Every guarantee mirrors the entry/prize verification:
 *   - the transaction EXISTS on the configured network
 *   - correct network (node's networkId must match)
 *   - sender is the HOST's linked wallet (the treasury of record here)
 *   - recipient is the ENTRANT's CURRENT linked wallet
 *   - value is EXACTLY the recorded entry fee (bigint luna)
 *   - execution succeeded on-chain
 *   - the hash has never been consumed for any payment before (durable
 *     replay guard — one hash settles exactly one obligation, ever)
 *
 * On success the refund row flips to 'dispatched' with the real hash; a
 * later confirm (≥8 confirmations) flips it to 'verified', which is what
 * lets a deleted/cancelled event close out its books.
 */

import {
  getTournamentDoc,
  mirrorRefund,
  withTournamentLock,
  type RefundRecord,
} from "@/lib/server/tournament-store";
import { NIMIQ_NETWORK, type NimiqNetworkName } from "@/lib/nimiq/config";
import {
  getTransactionByHash,
  getBlockNumber,
  getAccountByAddress,
  NimiqRpcError,
} from "@/lib/server/nimiq/rpc";
import { canonicalAddress } from "@/lib/nimiq/address";
import {
  fastStoreTxStore,
  type NimiqTxStore,
} from "@/lib/server/nimiq/transactions";
import { getLinkedWallet } from "@/lib/server/nimiq/service";
import { isAdminPlayer } from "@/lib/server/admin";
import { withPayoutLock } from "@/lib/server/tournament-payouts";

/** How many confirmations before a host-paid refund counts as verified. */
const REFUND_CONFIRMATIONS = 8;

export class RefundClaimError extends Error {
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, message: string, status = 400) {
    super(message);
    this.name = "RefundClaimError";
    this.kind = kind;
    this.status = status;
  }
}

/** What the client needs to prefill Nimiq Pay for a refund. */
export interface RefundReturnIntent {
  tournamentId: string;
  playerId: string;
  recipientAddress: string;
  amountLuna: string;
  network: NimiqNetworkName;
}

/**
 * Prepare: the exact wire facts the host's wallet needs for one refund.
 * Host-only; the refund must exist and still be returnable. The recipient is
 * the ENTRANT's current linked wallet — the host never types an address, so
 * a typo can never route someone's fee to a stranger.
 *
 * A 'dispatched' row WITHOUT a hash is released to 'failed' first when the
 * payout endpoint provably cannot sign (no broadcast can be in flight from
 * it), so a sweep-written dead intent never blocks the host's refund.
 */
export async function prepareRefundReturn(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
): Promise<RefundReturnIntent> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) throw new RefundClaimError("not-found", "Tournament not found", 404);
  if (doc.creatorId !== hostId && !(await isAdminPlayer(hostId))) {
    throw new RefundClaimError("not-host", "Only ChainMate or the host can return entry fees", 403);
  }

  let refund = doc.refunds?.[targetPlayerId];
  if (!refund) {
    throw new RefundClaimError("no-refund", "No refund obligation for that player", 404);
  }
  if (refund.status === "verified") {
    throw new RefundClaimError("already-refunded", "This entry fee has already been returned", 409);
  }
  if (refund.status === "dispatched" && refund.refundTxHash) {
    throw new RefundClaimError(
      "refund-in-flight",
      "A refund transaction is already in flight — use Check status",
      409,
    );
  }
  if (refund.status === "dispatched") {
    // No hash: the sweep wrote a write-ahead intent but nothing verifiable
    // exists. On a signing node the sweep's recovery owns this row; on a
    // read-only endpoint (or with no signer) nothing was ever broadcast —
    // sendPayout's unlock pre-check precedes any broadcast — so release it.
    const { payoutEndpointCannotSign } = await import("@/lib/server/tournament-payouts-dispatch");
    if (await payoutEndpointCannotSign()) {
      const released: RefundRecord = {
        ...refund,
        status: "failed",
        lastError: "Auto-dispatch unavailable on a read-only endpoint, released for host-wallet refund",
      };
      await persistRefund(tournamentId, released);
      refund = released;
    } else {
      throw new RefundClaimError(
        "refund-in-flight",
        "The settlement sweep is recovering this refund on the signing node",
        409,
      );
    }
  }
  // 'owed' | 'failed' → returnable.

  const wallet = await getLinkedWallet(targetPlayerId).catch(() => null);
  if (!wallet) {
    throw new RefundClaimError(
      "entrant-no-wallet",
      "That player has no linked Nimiq wallet yet — they must link one to receive their refund",
      409,
    );
  }

  return {
    tournamentId,
    playerId: targetPlayerId,
    recipientAddress: wallet.address,
    amountLuna: refund.amountLuna,
    network: NIMIQ_NETWORK,
  };
}

export interface RefundClaimResult {
  refund: RefundRecord;
  confirmations: number;
}

/**
 * Claim: verify the host's real on-chain refund and record it. Idempotent
 * per hash (durable consumption store) and per row (status transition).
 */
export async function claimRefundWithWalletTransaction(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
  txHashInput: string,
  deps: { txStore?: NimiqTxStore } = {},
): Promise<RefundClaimResult> {
  const txHash = txHashInput?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    throw new RefundClaimError("invalid-hash", "Transaction hash must be 64 hex characters");
  }

  // Same preparation gates (host, returnable) — then the plan.
  const intent = await prepareRefundReturn(tournamentId, hostId, targetPlayerId);
  const txStore = deps.txStore ?? fastStoreTxStore;

  return withPayoutLock(`refund:${tournamentId}:${targetPlayerId}`, async () => {
    const doc = await getTournamentDoc(tournamentId);
    const refund = doc?.refunds?.[targetPlayerId];
    if (!refund) throw new RefundClaimError("no-refund", "No refund obligation for that player", 404);
    if (refund.status === "verified") return { refund, confirmations: 0 };
    if (refund.status === "dispatched") {
      // Idempotent resume with the SAME hash (client retry, lost response);
      // a different hash means a second send may exist — the first stands.
      if (refund.refundTxHash === txHash) {
        const fresh = await confirmDispatchedRefund(tournamentId, hostId, targetPlayerId);
        return fresh;
      }
      throw new RefundClaimError(
        "refund-in-flight",
        "A refund transaction is already recorded — use Check status; do not send again",
        409,
      );
    }

    // --- durable replay guard: one hash settles exactly one obligation, ever.
    const existing = await txStore.findByNetworkAndHash(intent.network, txHash).catch(() => null);
    if (existing) {
      throw new RefundClaimError(
        "already-claimed",
        "This transaction was already used to settle a payment",
        409,
      );
    }

    // --- the real chain read.
    let tx: Awaited<ReturnType<typeof getTransactionByHash>>;
    try {
      tx = await getTransactionByHash(txHash, { timeoutMs: 10_000 });
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new RefundClaimError(
          "rpc-unavailable",
          `Could not reach the Nimiq node to verify this transaction (${err.message})`,
          503,
        );
      }
      throw err;
    }
    if (!tx || typeof tx !== "object" || typeof tx.hash !== "string" || !tx.hash) {
      throw new RefundClaimError(
        "not-found",
        "Transaction not found on the network yet — if it was just sent, wait a minute and try Check status again",
        404,
      );
    }

    // Network identity (fail closed without a node verdict).
    const { nimiqNetworkId } = await import("@/lib/nimiq/config");
    const withNetwork = tx as { networkId?: unknown; executionResult?: unknown };
    if (typeof withNetwork.networkId !== "number") {
      throw new RefundClaimError(
        "malformed-response",
        "Node response has no networkId, network cannot be established",
        502,
      );
    }
    if (withNetwork.networkId !== nimiqNetworkId(intent.network)) {
      throw new RefundClaimError(
        "wrong-network",
        "This transaction is on a different Nimiq network than this deployment",
      );
    }

    // Execution must have succeeded.
    if (typeof withNetwork.executionResult !== "boolean") {
      throw new RefundClaimError(
        "malformed-response",
        "Node response has no execution result, the outcome cannot be established",
        502,
      );
    }
    if (!withNetwork.executionResult) {
      throw new RefundClaimError("failed-transaction", "This transaction failed on-chain");
    }

    // Sender must be the HOST's linked wallet (wrapper accommodation as for
    // prizes and entries).
    const hostWallet = await getLinkedWallet(hostId).catch(() => null);
    if (!hostWallet) {
      throw new RefundClaimError(
        "host-no-wallet",
        "Link your Nimiq wallet first — refunds are verified against your linked wallet",
        409,
      );
    }
    const sender = canonicalAddress(String(tx.from ?? ""));
    const hostCanonical = canonicalAddress(hostWallet.address);
    let senderOk = sender === hostCanonical;
    if (!senderOk) {
      try {
        const acct = await getAccountByAddress(sender, { timeoutMs: 10_000 });
        const creator = acct && typeof acct === "object" ? acct.sender ?? acct.owner : null;
        if (creator && canonicalAddress(String(creator)) === hostCanonical) senderOk = true;
      } catch {
        // lookup failure → stays rejected
      }
    }
    if (!senderOk) {
      throw new RefundClaimError(
        "wrong-sender",
        "This transaction was not sent from your linked wallet — refunds must be paid by the host's linked account",
      );
    }

    // Recipient must be the entrant's linked wallet (the fresh intent one).
    const recipient = canonicalAddress(String(tx.to ?? ""));
    if (recipient !== canonicalAddress(intent.recipientAddress)) {
      throw new RefundClaimError(
        "wrong-recipient",
        "This transaction does not pay the entrant's linked wallet",
      );
    }

    // Amount must match the recorded entry fee exactly.
    let amountLuna: bigint;
    try {
      amountLuna = BigInt(tx.value);
    } catch {
      throw new RefundClaimError("malformed-response", "Node returned a non-integer value", 502);
    }
    if (amountLuna !== BigInt(intent.amountLuna)) {
      throw new RefundClaimError(
        "wrong-amount",
        `This transaction is not the recorded entry fee (${intent.amountLuna} luna)`,
      );
    }

    // Confirmations (inclusive boundary, same as entries and prizes).
    let height: number;
    try {
      height = await getBlockNumber({ timeoutMs: 10_000 });
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new RefundClaimError(
          "rpc-unavailable",
          `Could not read the chain height (${err.message})`,
          503,
        );
      }
      throw err;
    }
    const blockNumber = typeof tx.blockNumber === "number" ? tx.blockNumber : null;
    if (blockNumber == null) {
      throw new RefundClaimError(
        "malformed-response",
        "Node response has no block height, confirmations cannot be established",
        502,
      );
    }
    const confirmations = height - blockNumber + 1;
    if (confirmations < REFUND_CONFIRMATIONS) {
      // Below the verification threshold — but the identity gates all passed
      // and the return is ON THE CHAIN with at least one confirmation. The
      // fee has left the treasury; refusing to record it here kept the row
      // 'owed' with the return button still showing, inviting a second
      // payment. Commit the hash now (durable replay guard — this hash can
      // never settle another refund) and let the confirmations sweep mark
      // it 'verified' at threshold.
      await txStore.insertConsumed({
        network: intent.network,
        txHash,
        playerId: hostId,
        kind: "refund",
        tournamentId,
        sender,
        recipient,
        amountLuna: amountLuna.toString(),
        blockNumber,
        confirmations,
      });
      const dispatched: RefundRecord = {
        ...refund,
        status: "dispatched",
        refundTxHash: txHash,
        lastError: null,
      };
      await persistRefund(tournamentId, dispatched);
      return { refund: dispatched, confirmations };
    }

    // --- All gates passed. Consume the hash durably and record the refund.
    await txStore.insertConsumed({
      network: intent.network,
      txHash,
      playerId: hostId,
      kind: "refund",
      tournamentId,
      sender,
      recipient,
      amountLuna: amountLuna.toString(),
      blockNumber,
      confirmations,
    });

    const dispatched: RefundRecord = {
      ...refund,
      status: "dispatched",
      refundTxHash: txHash,
      lastError: null,
    };
    await persistRefund(tournamentId, dispatched);
    return { refund: dispatched, confirmations };
  });
}

/**
 * Re-check a claimed refund: refresh confirmations toward 'verified'. When
 * every refund of the tournament is verified the aggregate payout status
 * becomes 'refunded' (the settlement sweep also does this, but the host
 * should not have to wait for a tick).
 */
export async function confirmDispatchedRefund(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
): Promise<RefundClaimResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) throw new RefundClaimError("not-found", "Tournament not found", 404);
  if (doc.creatorId !== hostId && !(await isAdminPlayer(hostId))) {
    // Same rule as prizes: ChainMate settles refunds from the admin console.
    throw new RefundClaimError("not-host", "Only ChainMate or the host can manage refunds", 403);
  }
  const refund = doc.refunds?.[targetPlayerId];
  if (!refund) throw new RefundClaimError("no-refund", "No refund obligation for that player", 404);
  if (refund.status === "verified") return { refund, confirmations: 0 };
  if (refund.status !== "dispatched" || !refund.refundTxHash) {
    throw new RefundClaimError("not-dispatched", "No refund transaction to check yet", 409);
  }

  let tx: Awaited<ReturnType<typeof getTransactionByHash>>;
  try {
    tx = await getTransactionByHash(refund.refundTxHash, { timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof NimiqRpcError) {
      throw new RefundClaimError("rpc-unavailable", `Could not reach the Nimiq node (${err.message})`, 503);
    }
    throw err;
  }
  if (!tx || typeof tx !== "object" || typeof (tx as { blockNumber?: unknown }).blockNumber !== "number") {
    return { refund, confirmations: 0 };
  }
  const height = await getBlockNumber({ timeoutMs: 10_000 });
  const confirmations = height - (tx.blockNumber as number) + 1;
  if (confirmations < REFUND_CONFIRMATIONS) {
    return { refund, confirmations };
  }
  const verified: RefundRecord = {
    ...refund,
    status: "verified",
    verifiedAt: Date.now(),
  };
  await persistRefund(tournamentId, verified);
  await refreshRefundAggregate(tournamentId);
  return { refund: verified, confirmations };
}

/** Persist a refund row under the tournament lock and mirror it. */
async function persistRefund(tournamentId: string, refund: RefundRecord): Promise<void> {
  await withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return;
    doc.refunds = doc.refunds ?? {};
    doc.refunds[refund.playerId] = refund;
    // Write the whole document so the aggregate status follows too.
    const next = aggregateRefundStatusFor(doc);
    if (aggregateRank(next) >= aggregateRank(doc.payoutStatus)) {
      doc.payoutStatus = next as typeof doc.payoutStatus;
    }
    await import("@/lib/server/tournament-store").then((m) => m.writeTournamentDoc(doc));
  });
  await mirrorRefund(tournamentId, refund).catch(() => undefined);
}

/** Same rank ordering the settlement sweep's aggregate uses. */
function aggregateRank(status: string): number {
  const rank: Record<string, number> = {
    none: 0,
    pending: 1,
    refund_required: 2,
    partial: 3,
    paid: 4,
    refunded: 4,
  };
  return rank[status] ?? 0;
}

/**
 * Document-level aggregate from the refund ledger alone: refunded when every
 * obligation is verified, refund_required while any is outstanding, and
 * otherwise left alone (prize aggregates are the settlement sweep's job).
 */
function aggregateRefundStatusFor(doc: { refunds?: Record<string, RefundRecord>; payoutStatus: string }): string {
  const refunds = doc.refunds ? Object.values(doc.refunds) : [];
  if (refunds.length === 0) return doc.payoutStatus;
  return refunds.every((r) => r.status === "verified") ? "refunded" : "refund_required";
}

/** Recompute and persist the aggregate after a confirm flips a row. */
async function refreshRefundAggregate(tournamentId: string): Promise<void> {
  await withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return;
    const next = aggregateRefundStatusFor(doc);
    if (next !== doc.payoutStatus && aggregateRank(next) >= aggregateRank(doc.payoutStatus)) {
      doc.payoutStatus = next as typeof doc.payoutStatus;
      const m = await import("@/lib/server/tournament-store");
      await m.writeTournamentDoc(doc);
    }
  });
}
