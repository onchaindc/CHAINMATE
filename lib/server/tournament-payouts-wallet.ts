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
  getTransactionsByAddress,
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
import { isAdminPlayer } from "@/lib/server/admin";
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
  if (doc.creatorId !== hostId && !(await isAdminPlayer(hostId))) {
    // ChainMate (the platform admin) is the sole prize distributor and may
    // act on any event; a host may still act on their own.
    throw new PayoutClaimError("not-host", "Only ChainMate or the host can send prizes", 403);
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

  // Destination precedence:
  //   1. the winner's CURRENT linked wallet — the live binding is the truth
  //      after a re-link (and a binding mirrored to Supabase is now recovered
  //      even on a cold instance, which is what used to read "needs wallet");
  //   2. the plan-time destination — the address snapshot recorded when the
  //      payout was planned (resolved correctly THEN, and better than
  //      refusing when a cold instance cannot see the binding now);
  //   3. an ADMIN-set destination lives in the same snapshot field, so it
  //      falls out of rule 2 naturally.
  // Only when NEITHER resolves is the prize genuinely unpayable.
  const wallet = await getLinkedWallet(targetPlayerId).catch(() => null);
  const destination = wallet?.address ?? payout.destinationAddress ?? null;
  if (!destination) {
    throw new PayoutClaimError(
      "winner-no-wallet",
      "The winner has no linked Nimiq wallet yet — they must link one to receive the prize",
      409,
    );
  }

  return {
    tournamentId,
    playerId: targetPlayerId,
    recipientAddress: destination,
    amountLuna: payout.amountLuna,
    network: NIMIQ_NETWORK,
  };
}

/**
 * Discover a prize payment the host ALREADY SENT, from their wallet's
 * transaction history, and settle the row with it.
 *
 * Why this exists: legacy tournaments from before the host-wallet path
 * released their rows carry a payout the host may have paid out-of-band —
 * pressing Nimiq Pay and sending 20 NIM directly — with no hash ever
 * recorded server-side. The row sat at 'sending…' forever even though the
 * money had long landed. Wallet history lists the host's real outgoing
 * transactions, so a Check-status that scans it turns "stuck forever" into
 * "settled in one click" — with every identity gate of a manual claim
 * (network, sender, recipient, exact amount, executed, replay guard)
 * enforced by the same claim this calls. Nothing is trusted from the
 * history entry itself except the hash to look up.
 *
 * Returns null when no matching payment exists (NOT an error — the host
 * may simply not have paid yet).
 */
export async function discoverWalletPayout(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
  deps: { store?: PayoutStore; txStore?: NimiqTxStore; max?: number } = {},
): Promise<PayoutClaimResult | null> {
  const store = deps.store ?? fastStorePayoutStore;
  const payout = await store.get(tournamentId, targetPlayerId);
  if (!payout) throw new PayoutClaimError("no-payout", "No planned prize for that player", 404);
  if (payout.status === "sent" || payout.status === "verified") {
    return confirmSentWalletPayout(tournamentId, hostId, targetPlayerId, { store });
  }

  // The wire facts a real payment must match (this also runs the usual
  // prepare gates and releases a dead 'dispatching' row).
  const intent = await preparePayoutClaim(tournamentId, hostId, targetPlayerId);
  const txStore = deps.txStore ?? fastStoreTxStore;

  const hostWallet = await getLinkedWallet(hostId).catch(() => null);
  if (!hostWallet) return null;

  let history: Awaited<ReturnType<typeof getTransactionsByAddress>> = [];
  try {
    history = await getTransactionsByAddress(hostWallet.address, deps.max ?? 40, {
      timeoutMs: 10_000,
    });
  } catch {
    return null; // history is an optimisation, never a hard gate
  }

  const hostCanonical = canonicalAddress(hostWallet.address);
  const winnerCanonical = canonicalAddress(intent.recipientAddress);
  const expected = BigInt(intent.amountLuna);
  const { nimiqNetworkId } = await import("@/lib/nimiq/config");
  const wantNetwork = nimiqNetworkId(intent.network);

  // Newest first; the first EXACT match (recipient + exact amount, from the
  // host's own wallet) is the prize. Each candidate is re-verified by the
  // claim itself — the history entry contributes nothing but the hash.
  for (const entry of history) {
    const hash = String(entry.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    if (Number(entry.confirmations ?? 0) < 1) continue;
    if (canonicalAddress(String(entry.from ?? "")) !== hostCanonical) continue;
    if (canonicalAddress(String(entry.to ?? "")) !== winnerCanonical) continue;
    let value: bigint;
    try {
      value = BigInt(entry.value);
    } catch {
      continue;
    }
    if (value !== expected) continue;

    try {
      return await claimPayoutWithWalletTransaction(tournamentId, hostId, targetPlayerId, hash, {
        store,
        txStore,
      });
    } catch (err) {
      // A hash already consumed by ANOTHER settlement (the duplicate-send
      // case) is not this prize — keep scanning older sends.
      if (err instanceof PayoutClaimError && err.kind === "already-claimed") continue;
      throw err;
    }
  }
  return null;
}

/**
 * Resolve a prize row to its true state — the ONE action behind every
 * "Check status" button:
 *   sent/verified      → refresh confirmations toward verified
 *   dispatching w/hash → verify the recorded broadcast on-chain
 *   anything else      → scan the host's wallet history for an unrecorded
 *                        payment (discover) and settle it if found
 * Never broadcasts, never pays twice: the replay guard holds for every
 * path. Returns null only when the row is genuinely still owed.
 */
export async function resolvePayoutRow(
  tournamentId: string,
  hostId: string,
  targetPlayerId: string,
  deps: { store?: PayoutStore; txStore?: NimiqTxStore } = {},
): Promise<PayoutClaimResult | null> {
  const store = deps.store ?? fastStorePayoutStore;
  const payout = await store.get(tournamentId, targetPlayerId);
  if (!payout) throw new PayoutClaimError("no-payout", "No planned prize for that player", 404);
  if (payout.status === "sent" || payout.status === "verified") {
    return confirmSentWalletPayout(tournamentId, hostId, targetPlayerId, { store });
  }
  if (payout.status === "dispatching" && payout.payoutTxHash) {
    const { verifyOutgoingPayout } = await import("@/lib/server/tournament-payouts-dispatch");
    const verified = await verifyOutgoingPayout(tournamentId, targetPlayerId, { store });
    return { payout: verified, confirmations: 0 };
  }
  const found = await discoverWalletPayout(tournamentId, hostId, targetPlayerId, deps);
  if (found) return found;
  // Still owed — surface WHY the row cannot settle, so the host knows the
  // next action instead of re-pressing the same button.
  if (payout.status === "dispatching") {
    const { payoutEndpointCannotSign } = await import("@/lib/server/tournament-payouts-dispatch");
    if (!(await payoutEndpointCannotSign())) {
      throw new PayoutClaimError(
        "dispatch-in-flight",
        "The automatic payout is still in flight on the signing node — try again in a moment",
        409,
      );
    }
  }
  return null;
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

  // A settled row must resume (or refuse a second hash) BEFORE prepare —
  // prepare throws 'already-sent' for it, which would dead-end the client's
  // retry instead of converging.
  const preStore = deps.store ?? fastStorePayoutStore;
  const pre = await preStore.get(tournamentId, targetPlayerId).catch(() => null);
  if (pre && (pre.status === "verified" || (pre.status === "sent" && pre.payoutTxHash))) {
    if (pre.status === "verified" || pre.payoutTxHash === txHash) {
      return confirmSentWalletPayout(tournamentId, hostId, targetPlayerId, { store: preStore });
    }
    throw new PayoutClaimError(
      "already-sent",
      "This prize already has a transaction recorded — use Check status; do not send again",
      409,
    );
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
      // Idempotent resume: re-claiming with the SAME hash is the client's
      // retry path (a lost response, a reload mid-confirmation) — converge
      // on the current state instead of erroring. A DIFFERENT hash means
      // the host may have paid twice: refuse, the first transaction stands.
      if (payout.payoutTxHash === txHash) {
        const fresh = await confirmSentWalletPayout(tournamentId, hostId, targetPlayerId, { store });
        return fresh;
      }
      throw new PayoutClaimError(
        "already-sent",
        "This prize already has a transaction recorded — use Check status; do not send again",
        409,
      );
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
      // Below the verification threshold — but the transaction has passed
      // every identity gate (network, host sender, winner recipient, exact
      // amount, executed) and sits ON THE CHAIN with at least one
      // confirmation. The money has moved; refusing to record it here kept
      // the row 'pending' with the pay button still showing, and hosts paid
      // a SECOND time chasing a payment that was already finalising. So:
      // commit the hash now — the durable replay guard makes any further
      // claim with this hash impossible — mark the payout 'sent', and let
      // confirmSentWalletPayout advance it to 'verified' at 8.
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
    }

    // --- All gates passed at threshold. Consume the hash durably (replay
    // guard) and mark the payout sent with the real hash.
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
  if (doc.creatorId !== hostId && !(await isAdminPlayer(hostId))) {
    throw new PayoutClaimError("not-host", "Only ChainMate or the host can manage prizes", 403);
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
