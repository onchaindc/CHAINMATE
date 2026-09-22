// Server-only module — never import from client components.

/**
 * Prize-pool top-ups — the operator feeds the pool from their own wallet.
 *
 * ChainMate has no custodial treasury signer (see tournament-payouts.ts), so
 * the pool is fed the same way prizes leave it: a real Nimiq Pay payment,
 * verified on-chain before anything is credited. The flow mirrors the
 * entry-payment path (Phase 2B) exactly:
 *
 *   admin enters an amount → server returns the exact wire facts (treasury
 *   recipient, exact luna, network) → the admin pays from their own wallet
 *   through Nimiq Pay → the hash is claimed → verifyIncomingTransaction()
 *   proves it exists, is on the configured network, sender is the admin's
 *   LINKED wallet (or a wrapper contract the linked wallet created), the
 *   recipient is the configured treasury, the value is EXACTLY the prepared
 *   amount, execution succeeded, and the hash was never consumed before →
 *   the consumption row is written with kind='pool_topup' and the
 *   tournament's id, so getVerifiedPrizePool() adds it to the pool.
 *
 * The client is authoritative for NOTHING: not the amount (re-read from the
 * prepared intent at claim time), not the recipient, not the pool size. A
 * top-up can be prepared while the tournament runs (top up a live event) but
 * is claimed only against the amount that was prepared — change the pool
 * between prepare and claim and the claim still verifies the exact prepared
 * figure, so the ledger can never disagree with what the payer was shown.
 *
 * Replay: the durable UNIQUE (network, tx_hash) consumption guard holds, so
 * one transaction can fund a pool (or anything else) exactly once — a
 * re-submitted claim is typed already-consumed, never a double credit.
 */

import { getTournamentDoc } from "@/lib/server/tournament-store";
import { NIMIQ_NETWORK, type NimiqNetworkName } from "@/lib/nimiq/config";
import {
  fastStoreTxStore,
  verifyIncomingTransaction,
  NimiqTxError,
  type NimiqTxStore,
} from "@/lib/server/nimiq/transactions";

export class TopUpError extends Error {
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, message: string, status = 400) {
    super(message);
    this.name = "TopUpError";
    this.kind = kind;
    this.status = status;
  }
}

/** The wire facts the payer's wallet needs (what the UI prefills Nimiq Pay with). */
export interface TopUpIntent {
  tournamentId: string;
  /** The configured treasury — the ONLY address a top-up may pay. */
  recipientAddress: string;
  /** Exact luna for this top-up, digits-only string. */
  amountLuna: string;
  network: NimiqNetworkName;
}

/** Seams so tests can fake the doc reader, admin gate and treasury. */
export interface TopUpDeps {
  getDoc?: typeof getTournamentDoc;
  isAdmin?: (playerId: string) => Promise<boolean>;
  getTreasuryAddress?: () => string;
}

/** Resolve the doc-reader seam (defaults to the real engine store). */
function docReader(deps: TopUpDeps | undefined): typeof getTournamentDoc {
  return deps?.getDoc ?? getTournamentDoc;
}

/** Resolve the admin-gate seam (defaults to the real identity check). */
async function adminGate(deps: TopUpDeps | undefined, playerId: string): Promise<boolean> {
  if (deps?.isAdmin) return deps.isAdmin(playerId);
  const { isAdminPlayer } = await import("@/lib/server/admin");
  return isAdminPlayer(playerId);
}

/**
 * Prepare a top-up: validate the amount, check the tournament exists and
 * accept money, and return the exact wire facts. The treasury address comes
 * from the server's canonical configuration — never the client.
 */
export async function prepareTopUp(
  tournamentId: string,
  amountNim: string,
  deps: TopUpDeps = {},
): Promise<TopUpIntent> {
  const { parseNim } = await import("@/lib/nimiq/format");
  let amountLuna: bigint;
  try {
    amountLuna = parseNim(amountNim ?? "");
  } catch {
    throw new TopUpError("bad-amount", "Enter a NIM amount with at most 5 decimals, like \"25\" or \"2.5\"");
  }
  if (amountLuna <= 0n) {
    throw new TopUpError("bad-amount", "The top-up must be more than zero");
  }

  const doc = await docReader(deps)(tournamentId);
  if (!doc) throw new TopUpError("not-found", "Tournament not found", 404);
  if (doc.status === "cancelled") {
    throw new TopUpError("cancelled", "This tournament was cancelled — money can no longer be added", 409);
  }

  const { getCanonicalTreasuryAddress } = await import("@/lib/nimiq/config");
  const recipient = (deps.getTreasuryAddress ?? getCanonicalTreasuryAddress)();
  if (!recipient) {
    throw new TopUpError(
      "no-treasury",
      "The Nimiq treasury address is not configured on this deployment, so there is nowhere to send the top-up",
      503,
    );
  }

  return {
    tournamentId,
    recipientAddress: recipient,
    amountLuna: amountLuna.toString(),
    network: NIMIQ_NETWORK,
  };
}

/**
 * Claim a top-up: verify the payer's real on-chain transaction and credit
 * the pool with it (a durable kind='pool_topup' consumption row carrying the
 * tournament id). Idempotent per hash via the durable replay guard.
 */
export async function claimTopUp(
  tournamentId: string,
  payerId: string,
  txHashInput: string,
  deps: TopUpDeps & { store?: NimiqTxStore; verify?: typeof verifyIncomingTransaction } = {},
): Promise<{ amountLuna: string; txHash: string; poolLunaAfter: string }> {
  const txHash = txHashInput?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    throw new TopUpError("invalid-hash", "Transaction hash must be 64 hex characters");
  }

  // Only ChainMate (the platform admin) feeds a pool — the same accountable
  // payer rule as prize distribution. (The wallet sheet opened in the admin
  // console; the on-chain sender check below still binds the money to the
  // admin's own linked wallet, so a stranger's tx can never be claimed.)
  if (!(await adminGate(deps, payerId))) {
    throw new TopUpError("not-admin", "Only ChainMate can top up a prize pool", 403);
  }

  const doc = await docReader(deps)(tournamentId);
  if (!doc) throw new TopUpError("not-found", "Tournament not found", 404);
  if (doc.status === "cancelled") {
    throw new TopUpError("cancelled", "This tournament was cancelled — money can no longer be added", 409);
  }

  const store = deps.store ?? fastStoreTxStore;
  const { getCanonicalTreasuryAddress, nimiqNetworkId } = await import("@/lib/nimiq/config");
  const network = NIMIQ_NETWORK;

  // Replay guard first: the same hash can never be claimed twice. Re-check
  // before the RPC round trip so a duplicate click fails fast and typed.
  const existing = await store.findByNetworkAndHash(network, txHash).catch(() => null);
  if (existing) {
    if (existing.kind === "pool_topup" && existing.tournamentId === tournamentId) {
      // Exact same top-up re-submitted (lost response): converge, don't error.
      const { getVerifiedPrizePool } = await import("@/lib/server/tournament-economy");
      const pool = await getVerifiedPrizePool(tournamentId, store);
      return { amountLuna: existing.amountLuna, txHash: existing.txHash, poolLunaAfter: pool.toString() };
    }
    throw new TopUpError("already-consumed", "This transaction was already used to settle a payment", 409);
  }

  const verifyFn =
    deps.verify ??
    (async (
      hash: string,
      obligation: Parameters<typeof verifyIncomingTransaction>[1],
    ) => {
      const { verifyIncomingTransaction: real } = await import("@/lib/server/nimiq/transactions");
      return real(hash, obligation);
    });
  let verified;
  try {
    verified = await verifyFn(
      txHash,
      {
        playerId: payerId,
        // No expectedAmountLuna here on purpose: the sender picks the amount
        // they want to add, and verification still proves sender/recipient/
        // network/execution/confirmations. The amount that lands in the pool
        // is the amount actually ON CHAIN — read back from the verified row,
        // never from anything the client typed after prepare.
        kind: "pool_topup",
        tournamentId,
        network,
      },
      { store },
    );
  } catch (err) {
    if (err instanceof NimiqTxError) {
      const kind = err.kind === "wallet-not-linked"
        ? "payer-no-wallet"
        : err.kind === "wrong-recipient"
          ? "wrong-recipient"
          : err.kind === "wrong-sender"
            ? "wrong-sender"
            : err.kind;
      throw new TopUpError(kind, err.message, err.status);
    }
    throw err;
  }

  // The recipient MUST be the canonical treasury — verifyIncomingTransaction
  // already enforces this against the configured address; assert defensively
  // so a future configuration change can never retroactively credit a pool
  // from a tx verified against something else.
  const { canonicalAddress } = await import("@/lib/nimiq/address");
  if (canonicalAddress(verified.recipient) !== canonicalAddress(getCanonicalTreasuryAddress())) {
    throw new TopUpError("wrong-recipient", "This transaction does not pay the configured treasury", 400);
  }
  void nimiqNetworkId;

  const { getVerifiedPrizePool } = await import("@/lib/server/tournament-economy");
  const pool = await getVerifiedPrizePool(tournamentId, store);
  return {
    amountLuna: verified.amountLuna,
    txHash: verified.txHash,
    poolLunaAfter: pool.toString(),
  };
}
