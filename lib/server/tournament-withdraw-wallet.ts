// Server-only module — never import from client components.

/**
 * Host-wallet pool withdrawals — taking uncommitted pool money out when the
 * deployment has NO signing node.
 *
 * The node path (tournament-withdraw.ts) broadcasts from a treasury payout
 * node. This deployment has none: NIMIQ_PAYOUT_RPC_URL is unset and the only
 * configured endpoint is a read-only gateway. But the ADMIN's own wallet —
 * the very same one that pays top-ups INTO the pool — can pay a withdrawal
 * OUT to itself directly from Nimiq Pay, and ChainMate verifies that real
 * on-chain transaction. Same shape as the host-wallet refund path
 * (tournament-refunds-wallet.ts):
 *
 *   prepare → the exact wire facts (recipient = the admin's OWN linked
 *             wallet, amount = the validated uncommitted remainder) with
 *             every server-side gate enforced BEFORE the wallet opens.
 *   claim   → the admin's real transaction is verified against the chain:
 *             exists on the configured network, correct networkId, sender is
 *             the admin's linked wallet, recipient is the linked wallet,
 *             execution succeeded — and then EVERY money gate is re-run
 *             against the transaction's own value (admin-only, live event,
 *             purse cut, THE CAP), so a commitment made between opening the
 *             wallet and pressing send can still refuse the claim. The hash
 *             has never settled any payment before (durable replay guard —
 *             one hash settles exactly one payment, ever).
 *
 * Nothing else is relaxed: the wallet path replaces only the BROADCAST step
 * with a verified human payment. The withdrawal is recorded in the same
 * ledger as node-path withdrawals (status 'sent', real hash, via='wallet')
 * and rides the same confirm flow (confirmPoolWithdrawal) and cap accounting.
 */

import { getTournamentDoc } from "@/lib/server/tournament-store";
import { NIMIQ_NETWORK, nimiqNetworkId, type NimiqNetworkName } from "@/lib/nimiq/config";
import { canonicalAddress } from "@/lib/nimiq/address";
import {
  getTransactionByHash,
  getBlockNumber,
  getAccountByAddress,
  NimiqRpcError,
} from "@/lib/server/nimiq/rpc";
import { fastStoreTxStore, type NimiqTxStore } from "@/lib/server/nimiq/transactions";
import { getLinkedWallet } from "@/lib/server/nimiq/service";
import { parseNim, formatNim } from "@/lib/nimiq/format";
import {
  availablePoolLuna,
  fastStoreWithdrawStore,
  WithdrawError,
  type WithdrawDeps,
  type WithdrawRecord,
} from "@/lib/server/tournament-withdraw";
import { fastStorePayoutStore, withPayoutLock } from "@/lib/server/tournament-payouts";

/** What the client needs to prefill Nimiq Pay for a withdrawal. */
export interface WithdrawIntent {
  tournamentId: string;
  recipientAddress: string;
  amountLuna: string;
  network: NimiqNetworkName;
}

/**
 * Every server-side gate a withdrawal must pass, for a concrete luna amount.
 * Shared by prepare (the typed amount) and claim (the transaction's own
 * value) so the two paths can never diverge. Returns the verified
 * destination (the admin's linked wallet).
 */
async function assertWithdrawable(
  tournamentId: string,
  adminPlayerId: string,
  amountLuna: bigint,
  deps: WithdrawDeps,
): Promise<{ recipient: string; network: NimiqNetworkName }> {
  if (!(await adminGate(deps, adminPlayerId))) {
    throw new WithdrawError("not-admin", "Only ChainMate can withdraw from a prize pool", 403);
  }
  const doc = await (deps.getDoc ?? getTournamentDoc)(tournamentId);
  if (!doc) throw new WithdrawError("not-found", "Tournament not found", 404);

  // Money only leaves a LIVE event — same rule as the node path (top-ups go
  // INTO live events only; withdrawals come OUT of them only).
  if (doc.status === "completed" || doc.status === "cancelled") {
    throw new WithdrawError(
      "tournament-ended",
      doc.status === "completed"
        ? "This tournament has ended — its pool belongs to the prizes. Withdrawals only work on live events."
        : "This tournament was cancelled — its pool is being refunded. Withdrawals only work on live events.",
      409,
    );
  }

  // A paid tournament with a preset but NO cut purse must not be drained
  // before the winners are even planned — same rule as the node path.
  const { isPaidTournamentDoc } = await import("@/lib/server/tournament-economy-doc");
  if (isPaidTournamentDoc(doc) && doc.prizePreset) {
    const payouts = await (deps.payoutStore ?? fastStorePayoutStore).listByTournament(tournamentId);
    if (payouts.length === 0) {
      throw new WithdrawError(
        "purse-not-cut",
        "Cut the purse first — distribute the pool as top 1 / top 3 / top 5, then withdraw what remains",
        409,
      );
    }
  }

  // THE CAP: only uncommitted funds may leave — read from the durable
  // ledgers, never a client number.
  const { poolLuna, committedLuna, availableLuna } = await availablePoolLuna(tournamentId, deps);
  if (amountLuna > availableLuna) {
    throw new WithdrawError(
      "insufficient-available",
      `Only ${formatNim(availableLuna)} NIM of the ${formatNim(poolLuna)} NIM pool is uncommitted — ${formatNim(committedLuna)} NIM is locked by prizes, refunds and withdrawals`,
      409,
    );
  }

  // Destination: the admin's own linked wallet — the same wallet that pays
  // top-ups in. The server resolves it; a typo can never route pool money
  // to a stranger.
  const wallet = deps.getLinkedWallet
    ? await deps.getLinkedWallet(adminPlayerId).catch(() => null)
    : await getLinkedWallet(adminPlayerId).catch(() => null);
  if (!wallet?.address) {
    throw new WithdrawError(
      "no-recipient",
      "Link a Nimiq wallet to your ChainMate account first — withdrawals go to the linked wallet",
    );
  }
  return { recipient: canonicalAddress(wallet.address), network: NIMIQ_NETWORK };
}

/**
 * Prepare: the exact wire facts for one withdrawal, with every gate enforced
 * before the admin's wallet opens. Pure read — a failed or abandoned send
 * leaves no ledger row behind (the row is written only when a real
 * transaction verifies).
 */
export async function preparePoolWithdrawal(
  tournamentId: string,
  adminPlayerId: string,
  amountNim: string,
  deps: WithdrawDeps = {},
): Promise<WithdrawIntent> {
  let amountLuna: bigint;
  try {
    amountLuna = parseNim(amountNim ?? "");
  } catch {
    throw new WithdrawError("bad-amount", "Enter a NIM amount with at most 5 decimals, like \"25\" or \"2.5\"");
  }
  if (amountLuna <= 0n) {
    throw new WithdrawError("bad-amount", "The withdrawal must be more than zero");
  }
  const { recipient, network } = await assertWithdrawable(tournamentId, adminPlayerId, amountLuna, deps);
  return {
    tournamentId,
    recipientAddress: recipient,
    amountLuna: amountLuna.toString(),
    network,
  };
}

export interface WalletWithdrawResult {
  withdrawal: WithdrawRecord;
  confirmations: number;
}

/**
 * Claim: verify the admin's real on-chain withdrawal and record it as
 * 'sent'. Idempotent per hash (durable consumption store) and per row
 * (in-flight guard). The transaction's own value is the claimed amount —
 * every money gate is re-run against it at claim time.
 */
export async function claimPoolWithdrawalWithWalletTransaction(
  tournamentId: string,
  adminPlayerId: string,
  txHashInput: string,
  deps: WithdrawDeps = {},
): Promise<WalletWithdrawResult> {
  const txHash = txHashInput?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    throw new WithdrawError("invalid-hash", "Transaction hash must be 64 hex characters");
  }

  const txStore: NimiqTxStore = deps.txStore ?? fastStoreTxStore;
  const store = deps.store ?? fastStoreWithdrawStore;
  const now = deps.now ?? Date.now;

  return withPayoutLock(`withdraw-wallet:${tournamentId}`, async () => {
    // In-flight guard FIRST (before any node round trip): a wallet row is
    // written already 'sent' with its hash, so a retry of the SAME hash
    // converges; any other active row means one withdrawal at a time.
    const rows = await store.listByTournament(tournamentId);
    const last = rows[rows.length - 1];
    if (last && (last.status === "sent" || last.status === "dispatching")) {
      if (last.withdrawTxHash === txHash) {
        return { withdrawal: last, confirmations: 0 };
      }
      throw new WithdrawError(
        "withdrawal-in-flight",
        "A withdrawal is already in flight — check status before withdrawing again",
        409,
      );
    }
    // 'failed' (or no rows) → a fresh claim proceeds.

    // --- durable replay guard: one hash settles exactly one payment, ever.
    const existing = await txStore.findByNetworkAndHash(NIMIQ_NETWORK, txHash).catch(() => null);
    if (existing) {
      throw new WithdrawError(
        "already-consumed",
        "This transaction was already used to settle a payment",
        409,
      );
    }

    // --- the real chain read.
    const fetchTx =
      deps.getTransactionByHash ??
      (async (hash: string, overrides?: Record<string, unknown>) =>
        getTransactionByHash(hash, overrides as Parameters<typeof getTransactionByHash>[1]));
    let tx: {
      hash?: string;
      from?: string;
      to?: string;
      value?: string;
      blockNumber?: number;
      executionResult?: unknown;
      networkId?: unknown;
    };
    try {
      tx = (await fetchTx(txHash, { timeoutMs: 10_000 })) as typeof tx;
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new WithdrawError(
          "rpc-unavailable",
          `Could not reach the Nimiq node to verify this transaction (${err.message})`,
          503,
        );
      }
      throw err;
    }
    if (!tx || typeof tx !== "object" || !tx.hash) {
      throw new WithdrawError(
        "not-found",
        "Transaction not found on the network yet — if it was just sent, wait a minute and try again",
        404,
      );
    }

    // Network identity (fail closed without a node verdict).
    const expectedId = nimiqNetworkId(NIMIQ_NETWORK);
    if (typeof tx.networkId !== "number") {
      throw new WithdrawError(
        "malformed-response",
        "Node response has no networkId, network cannot be established",
        502,
      );
    }
    if (tx.networkId !== expectedId) {
      throw new WithdrawError(
        "wrong-network",
        "This transaction is on a different Nimiq network than this deployment",
        502,
      );
    }

    // Execution must have succeeded.
    if (typeof tx.executionResult !== "boolean") {
      throw new WithdrawError(
        "malformed-response",
        "Node response has no execution result, the outcome cannot be established",
        502,
      );
    }
    if (!tx.executionResult) {
      throw new WithdrawError("failed-execution", "This transaction failed on-chain execution", 502);
    }

    // Sender must be the ADMIN's linked wallet (wrapper accommodated, as
    // for refunds, prizes and top-ups).
    const adminWallet = deps.getLinkedWallet
      ? await deps.getLinkedWallet(adminPlayerId).catch(() => null)
      : await getLinkedWallet(adminPlayerId).catch(() => null);
    if (!adminWallet) {
      throw new WithdrawError(
        "no-recipient",
        "Link your Nimiq wallet first — withdrawals are verified against your linked wallet",
        409,
      );
    }
    const sender = canonicalAddress(String(tx.from ?? ""));
    const adminCanonical = canonicalAddress(adminWallet.address);
    let senderOk = sender === adminCanonical;
    if (!senderOk) {
      try {
        const acct = await getAccountByAddress(sender, { timeoutMs: 10_000 });
        const owner =
          acct && typeof acct === "object"
            ? (acct as { sender?: unknown }).sender ?? (acct as { owner?: unknown }).owner
            : null;
        if (owner && canonicalAddress(String(owner)) === adminCanonical) senderOk = true;
      } catch {
        // lookup failure → stays rejected
      }
    }
    if (!senderOk) {
      throw new WithdrawError(
        "wrong-sender",
        "This transaction was not sent from your linked wallet — withdrawals must come from the wallet that tops up",
        502,
      );
    }

    // Recipient must be the admin's linked wallet too: a withdrawal pays
    // YOURSELF the pool's uncommitted remainder.
    const recipient = canonicalAddress(String(tx.to ?? ""));
    if (recipient !== adminCanonical) {
      throw new WithdrawError("wrong-recipient", "This transaction does not pay your linked wallet", 502);
    }

    // The transaction's own value is the claimed amount.
    let amountLuna: bigint;
    try {
      amountLuna = BigInt(String(tx.value ?? ""));
    } catch {
      throw new WithdrawError("malformed-response", "Node returned a non-integer transaction value", 502);
    }

    // --- every money gate, re-run against the transaction's own amount.
    const { recipient: verifiedRecipient, network } = await assertWithdrawable(
      tournamentId,
      adminPlayerId,
      amountLuna,
      deps,
    );
    if (verifiedRecipient !== adminCanonical) {
      // The linked wallet changed between send and claim — the payment no
      // longer matches the destination of record.
      throw new WithdrawError(
        "wrong-recipient",
        "Your linked wallet changed — link the wallet you sent from and try again",
        409,
      );
    }

    // Inclusion in a block — a mempool tx cannot be recorded yet.
    if (typeof tx.blockNumber !== "number" || tx.blockNumber < 0) {
      throw new WithdrawError(
        "reconciliation-required",
        "The transaction is not included in a block yet — wait a moment and try again",
        409,
      );
    }

    // Confirmations (recorded; the confirm flow enforces the threshold).
    const heightOf =
      deps.getBlockNumber ??
      (async (overrides?: Record<string, unknown>) =>
        getBlockNumber(overrides as Parameters<typeof getBlockNumber>[0]));
    let height: number;
    try {
      height = await heightOf({ timeoutMs: 10_000 });
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new WithdrawError("rpc-unavailable", `Could not read the chain height (${err.message})`, 503);
      }
      throw err;
    }
    const confirmations = Math.max(height - tx.blockNumber + 1, 0);

    // --- All gates passed. Consume the hash durably and record the row.
    await txStore.insertConsumed({
      network,
      txHash,
      playerId: adminPlayerId,
      kind: "pool_withdrawal",
      tournamentId,
      sender,
      recipient,
      amountLuna: amountLuna.toString(),
      blockNumber: tx.blockNumber,
      confirmations,
    });

    const sent: WithdrawRecord = {
      id: `withdraw_${now()}_${Math.random().toString(36).slice(2, 8)}`,
      tournamentId,
      amountLuna: amountLuna.toString(),
      recipientAddress: recipient,
      network,
      status: "sent",
      withdrawTxHash: txHash,
      senderAddress: sender,
      // Wallet path marker: no treasury broadcast, no write-ahead vsh.
      // confirmPoolWithdrawal reads this as "verify against the recorded
      // sending wallet, not the configured treasury".
      validityStartHeight: null,
      via: "wallet",
      dispatchAttempts: 1,
      lastBroadcastAt: now(),
      failureReason: null,
      requestedAt: now(),
      sentAt: now(),
      verifiedAt: null,
    };
    await store.replace(sent);
    return { withdrawal: sent, confirmations };
  });
}

async function adminGate(deps: WithdrawDeps | undefined, playerId: string): Promise<boolean> {
  if (deps?.isAdmin) return deps.isAdmin(playerId);
  const { isAdminPlayer } = await import("@/lib/server/admin");
  return isAdminPlayer(playerId);
}
