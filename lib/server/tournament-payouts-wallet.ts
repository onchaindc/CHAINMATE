// Server-only module — never import from client components.

/**
 * Host-wallet payout settlement — the zero-infrastructure treasury.
 *
 * The deployment has no signing node (a read-only public gateway cannot
 * sign), so the HOST pays each prize from their own Nimiq Pay wallet and
 * ChainMate verifies that real on-chain transaction against the payout
 * record. Every guarantee mirrors the entry-payment path:
 *
 *   - the transaction EXISTS on the configured network
 *   - correct network (node's networkId must match)
 *   - sender is the HOST's linked wallet (the treasury of record here)
 *   - recipient is the WINNER's linked wallet (payout destination)
 *   - value is EXACTLY the planned prize (bigint luna)
 *   - execution succeeded on-chain
 *   - the hash has never been claimed for any payout before (durable
 *     replay guard — the same consumed-tx store entries use)
 *
 * On success the payout row flips to 'sent' with the real hash, and the
 * standard confirmations gate ('verified') stays available through the
 * existing verify action.
 */

import { getTournamentDoc } from "@/lib/server/tournament-store";
import { getCanonicalTreasuryAddress, NIMIQ_NETWORK, type NimiqNetworkName } from "@/lib/nimiq/config";
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
import {
  getLinkedWallet,
} from "@/lib/server/nimiq/service";
import {
  fastStorePayoutStore,
  withPayoutLock,
  type PayoutRecord,
  type PayoutStore,
} from "@/lib/server/tournament-payouts";

/** How many confirmations before a host-paid prize counts as verified. */
const PAYOUT_CONFIRMATIONS = 8;

export class PayoutClaimError extends Error {
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, message: string, status = 400) {
    super(message);
    this.name = "PayoutClaimError";
    this.kind = kind;
    this.status = status;
  }
}

/** What the client needs to prefill Nimiq Pay. */
export interface PayoutClaimIntent {
  tournamentId: string;
  playerId: string;
  recipientAddress: string;
  amountLuna: string;
  network: NimiqNetworkName;
}

/**
 * Prepare: the exact wire facts the host's wallet needs. Host-only, and the
 * payout must exist and still be unsettled. The address is the WINNER's
 * linked wallet — the host never types an address, so a typo can never
 * route a prize to a stranger.
 */
export async function preparePayoutClaim(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
): Promise<PayoutClaimIntent> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) throw new PayoutClaimError("not-found", "Tournament not found", 404);
  if (doc.creatorId !== hostId) {
    throw new PayoutClaimError("not-host", "Only the host can send prizes", 403);
  }
  if (doc.status !== "completed") {
    throw new PayoutClaimError("not-completed", "Prizes can be sent only after the tournament completes", 409);
  }

  const store: PayoutStore = fastStorePayoutStore;
  let payout = await store.get(tournamentId, targetPlayerId);
  if (!payout) throw new PayoutClaimError("no-payout", "No planned prize for that player", 404);
  if (payout.status === "sent" || payout.status === "verified") {
    throw new PayoutClaimError("already-sent", "This prize has already been sent", 409);
  }
  if (payout.status === "dispatching") {
    // A WAL row can only be released when no transaction can possibly be
    // in flight from it. On a signing node, dispatch re-broadcasts the
    // recorded intent (recovery) and must NOT be bypassed — the host-wallet
    // path refuses, and the sweep resolves the row. But on a read-only
    // endpoint (or a missing signer) nothing was ever broadcast: the row is
    // dead weight that blocks this prize forever with "send in progress" —
    // the exact stuck state legacy tournaments (pre-release fix) are in.
    // sendPayout's unlock pre-check guarantees no broadcast occurred on an
    // endpoint that cannot sign, so releasing here is provably safe. The
    // release lives in PREPARE (not only in the claim) because prepare is
    // what both the UI's "pay from wallet" entry point and the claim itself
    // hit first — a release that runs only after prepare could never run.
    const { payoutEndpointCannotSign } = await import("@/lib/server/tournament-payouts-dispatch");
    if (!(await payoutEndpointCannotSign())) {
      throw new PayoutClaimError(
        "dispatch-in-flight",
        "An automatic payout dispatch is in flight on the signing node. Use Check status to resolve it first.",
        409,
      );
    }
    const released: PayoutRecord = {
      ...payout,
      status: "failed",
      failureReason: "Auto-dispatch unavailable on a read-only endpoint, released for host-wallet payment",
    };
    await store.upsert(released);
    const { mirrorPayouts } = await import("@/lib/server/tournament-payouts");
    await mirrorPayouts(tournamentId, [released]).catch(() => undefined);
    payout = released; // the claim below proceeds against the released row
  }

  // Destination: the winner's CURRENT linked wallet (the planning record's
  // snapshot can be stale after a re-link — the live binding is the truth).
  const wallet = await getLinkedWallet(targetPlayerId).catch(() => null);
  if (!wallet) {
    throw new PayoutClaimError(
      "winner-no-wallet",
      "The winner has no linked Nimiq wallet yet — they must link one to receive the prize",
      409,
    );
  }

  return {
    tournamentId,
    playerId: targetPlayerId,
    recipientAddress: wallet.address,
    amountLuna: payout.amountLuna,
    network: NIMIQ_NETWORK,
  };
}

export interface PayoutClaimResult {
  payout: PayoutRecord;
  confirmations: number;
}

/**
 * Claim: verify the host's real on-chain transaction and mark the prize sent.
 * Idempotent per hash (durable store) and per payout (row transition).
 */
export async function claimPayoutWithWalletTransaction(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
  txHashInput: string,
  deps: { store?: PayoutStore; txStore?: NimiqTxStore } = {},
): Promise<PayoutClaimResult> {
  const txHash = txHashInput?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    throw new PayoutClaimError("invalid-hash", "Transaction hash must be 64 hex characters");
  }

  // Same preparation gates (host, completed, unsettled) — then the plan.
  const intent = await preparePayoutClaim(tournamentId, hostId, targetPlayerId);

  const store = deps.store ?? fastStorePayoutStore;
  const txStore = deps.txStore ?? fastStoreTxStore;

  return withPayoutLock(`send:${tournamentId}:${targetPlayerId}`, async () => {
    const payout = await store.get(tournamentId, targetPlayerId);
    if (!payout) throw new PayoutClaimError("no-payout", "No planned prize for that player", 404);
    if (payout.status === "verified") return { payout, confirmations: 0 };
    if (payout.status === "sent") {
      throw new PayoutClaimError("already-sent", "This prize already has a transaction in flight", 409);
    }
    if (payout.status === "dispatching") {
      // preparePayoutClaim already ran the read-only probe and either
      // released the row (to 'failed', status above) or refused. Reaching
      // here still 'dispatching' means a signing node owns the row: the
      // dispatch may genuinely be mid-flight — recovery, not replacement,
      // is the safe action.
      throw new PayoutClaimError(
        "dispatch-in-flight",
        "An automatic payout dispatch is in flight on the signing node. Use Check status to resolve it first.",
        409,
      );
    }

    // --- durable replay guard: one hash can settle exactly one prize, ever.
    const existing = await txStore
      .findByNetworkAndHash(intent.network, txHash)
      .catch(() => null);
    if (existing) {
      throw new PayoutClaimError(
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
        throw new PayoutClaimError(
          "rpc-unavailable",
          `Could not reach the Nimiq node to verify this transaction (${err.message})`,
          503,
        );
      }
      throw err;
    }
    if (!tx || typeof tx !== "object" || typeof tx.hash !== "string" || !tx.hash) {
      throw new PayoutClaimError(
        "not-found",
        "Transaction not found on the network yet — if it was just sent, wait a minute and try Check status again",
        404,
      );
    }

    // Network identity (fail closed without a node verdict).
    const { nimiqNetworkId } = await import("@/lib/nimiq/config");
    const withNetwork = tx as { networkId?: unknown; executionResult?: unknown; fromType?: unknown };
    if (typeof withNetwork.networkId !== "number") {
      throw new PayoutClaimError(
        "malformed-response",
        "Node response has no networkId, network cannot be established",
        502,
      );
    }
    if (withNetwork.networkId !== nimiqNetworkId(intent.network)) {
      throw new PayoutClaimError(
        "wrong-network",
        "This transaction is on a different Nimiq network than this deployment",
      );
    }

    // Execution must have succeeded.
    if (typeof withNetwork.executionResult !== "boolean") {
      throw new PayoutClaimError(
        "malformed-response",
        "Node response has no execution result, the outcome cannot be established",
        502,
      );
    }
    if (!withNetwork.executionResult) {
      throw new PayoutClaimError("failed-transaction", "This transaction failed on-chain");
    }

    // Sender must be the HOST's linked wallet. Nimiq Pay wrapper contracts
    // are handled the same way entries are: a contract CREATED by the linked
    // wallet counts (the wallet sweeps balances into HTLC/vesting wrappers
    // and pays from them).
    const hostWallet = await getLinkedWallet(hostId).catch(() => null);
    if (!hostWallet) {
      throw new PayoutClaimError(
        "host-no-wallet",
        "Link your Nimiq wallet first — prizes are verified against the host's linked wallet",
        409,
      );
    }
    const sender = canonicalAddress(String(tx.from ?? ""));
    const hostCanonical = canonicalAddress(hostWallet.address);
    let senderOk = sender === hostCanonical;
    if (!senderOk) {
      // Owned-wrapper accommodation: creator lookup on the sender account.
      try {
        const acct = await getAccountByAddress(sender, { timeoutMs: 10_000 });
        const creator = acct && typeof acct === "object" ? acct.sender ?? acct.owner : null;
        if (creator && canonicalAddress(String(creator)) === hostCanonical) senderOk = true;
      } catch {
        // lookup failure → stays rejected
      }
    }
    if (!senderOk) {
      throw new PayoutClaimError(
        "wrong-sender",
        "This transaction was not sent from your linked wallet — prizes must be paid by the host's linked account",
      );
    }

    // Recipient must be the winner's linked wallet (the fresh intent one).
    const recipient = canonicalAddress(String(tx.to ?? ""));
    if (recipient !== canonicalAddress(intent.recipientAddress)) {
      throw new PayoutClaimError(
        "wrong-recipient",
        "This transaction does not pay the winner's linked wallet",
      );
    }

    // Amount must match the planned prize exactly.
    let amountLuna: bigint;
    try {
      amountLuna = BigInt(tx.value);
    } catch {
      throw new PayoutClaimError("malformed-response", "Node returned a non-integer value", 502);
    }
    if (amountLuna !== BigInt(intent.amountLuna)) {
      throw new PayoutClaimError(
        "wrong-amount",
        `This transaction is not the planned prize amount (${intent.amountLuna} luna)`,
      );
    }

    // Confirmations (inclusive boundary, same as entries).
    let height: number;
    try {
      height = await getBlockNumber({ timeoutMs: 10_000 });
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new PayoutClaimError(
          "rpc-unavailable",
          `Could not read the chain height (${err.message})`,
          503,
        );
      }
      throw err;
    }
    const blockNumber = typeof tx.blockNumber === "number" ? tx.blockNumber : null;
    if (blockNumber == null) {
      throw new PayoutClaimError(
        "malformed-response",
        "Node response has no block height, confirmations cannot be established",
        502,
      );
    }
    const confirmations = height - blockNumber + 1;
    if (confirmations < PAYOUT_CONFIRMATIONS) {
      throw new PayoutClaimError(
        "insufficient-confirmations",
        `This transaction has ${Math.max(confirmations, 0)} confirmations, ${PAYOUT_CONFIRMATIONS} required. Wait a moment and press Check status again.`,
        409,
      );
    }

    // --- All gates passed. Consume the hash durably (replay guard) and mark
    // the payout sent with the real hash.
    await txStore.insertConsumed({
      network: intent.network,
      txHash,
      playerId: hostId,
      kind: "verification", // outgoing settlements are not entries
      tournamentId,
      sender,
      recipient,
      amountLuna: amountLuna.toString(),
      blockNumber,
      confirmations,
    });

    const sent: PayoutRecord = {
      ...payout,
      status: "sent",
      payoutTxHash: txHash,
      sentAt: Date.now(),
      failureReason: null,
      destinationAddress: intent.recipientAddress,
    };
    await store.upsert(sent);
    const { mirrorPayouts } = await import("@/lib/server/tournament-payouts");
    await mirrorPayouts(tournamentId, [sent]).catch(() => undefined);
    return { payout: sent, confirmations };
  });
}

/** Re-check an already-claimed prize: refresh confirmations toward 'verified'. */
export async function confirmSentWalletPayout(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
  deps: { store?: PayoutStore } = {},
): Promise<PayoutClaimResult> {
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) throw new PayoutClaimError("not-found", "Tournament not found", 404);
  if (doc.creatorId !== hostId) {
    throw new PayoutClaimError("not-host", "Only the host can manage prizes", 403);
  }
  const store = deps.store ?? fastStorePayoutStore;
  const payout = await store.get(tournamentId, targetPlayerId);
  if (!payout) throw new PayoutClaimError("no-payout", "No planned prize for that player", 404);
  if (payout.status === "verified") return { payout, confirmations: 0 };
  if (payout.status !== "sent" || !payout.payoutTxHash) {
    throw new PayoutClaimError("not-sent", "No sent transaction to check yet", 409);
  }

  let tx: Awaited<ReturnType<typeof getTransactionByHash>>;
  try {
    tx = await getTransactionByHash(payout.payoutTxHash, { timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof NimiqRpcError) {
      throw new PayoutClaimError("rpc-unavailable", `Could not reach the Nimiq node (${err.message})`, 503);
    }
    throw err;
  }
  if (!tx || typeof tx !== "object" || typeof (tx as { blockNumber?: unknown }).blockNumber !== "number") {
    return { payout, confirmations: 0 };
  }
  const height = await getBlockNumber({ timeoutMs: 10_000 });
  const confirmations = height - (tx.blockNumber as number) + 1;
  if (confirmations < PAYOUT_CONFIRMATIONS) {
    return { payout, confirmations };
  }
  const verified: PayoutRecord = {
    ...payout,
    status: "verified",
    verifiedAt: Date.now(),
  };
  await store.upsert(verified);
  const { mirrorPayouts } = await import("@/lib/server/tournament-payouts");
  await mirrorPayouts(tournamentId, [verified]).catch(() => undefined);
  return { payout: verified, confirmations };
}

// Re-exported for the route's treasury sanity note.
export { getCanonicalTreasuryAddress };
