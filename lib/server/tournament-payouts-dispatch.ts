// Server-only module — never import from client components.

/**
 * Treasury payout dispatch — ChainMate Phase 3B.
 *
 * Implements the REAL dispatch of a planned payout through a dedicated
 * payout node (keystore-held treasury key), with a crash-safe protocol that
 * makes double-payment impossible across retries, crashes, and concurrent
 * requests:
 *
 *  1. WRITE-AHEAD: persist status='dispatching' + sender + amount +
 *     validity_start_height (vsh) BEFORE any broadcast (migration 0010 makes
 *     this a schema-level CHECK).
 *  2. Broadcast with that recorded vsh.
 *  3. Persist the returned hash → 'sent'.
 *  4. Verify on-chain (sender/recipient/value/success/confirmations) →
 *     'verified'.
 *
 * CRASH BETWEEN 2 AND 3 (broadcast succeeded, hash lost):
 *   The recovery path (dispatchPayout again, or reconcileDispatchingPayouts)
 *   re-broadcasts with the SAME recorded vsh. Nimiq transactions are a pure
 *   function of their fields — TransactionBuilder::new_basic(keypair,
 *   recipient, value, fee, vsh, network) has no randomness or timestamps, and
 *   ed25519 signing is deterministic (RFC 8032) — so the re-broadcast is
 *   byte-identical and carries the SAME hash as the original. The chain
 *   itself then dedupes (mempool contains() by hash; validity-store replay
 *   window). Exactly one effective payment exists no matter where the
 *   process died.
 *
 * CRASH BETWEEN 1 AND 2 (intent recorded, nothing broadcast):
 *   Same path: the re-broadcast with the recorded vsh IS the first broadcast.
 *
 * WHY NOT CHAIN-SCAN RECONCILIATION: a broadcast-but-unmined transaction is
 * NOT in getTransactionsByAddress history (history lists INCLUDED
 * transactions), so "scan first, broadcast if absent" could double-pay.
 * Deterministic re-broadcast with a reused vsh is the only sound strategy,
 * and it needs no scan at all.
 *
 * VSH LIFECYCLE BOUND: a vsh's validity window on Nimiq Albatross is
 * Policy::TRANSACTION_VALIDITY_WINDOW batches × BLOCKS_PER_BATCH blocks —
 * 120 × 60 = 7,200 blocks (core-rs-albatross primitives/src/policy.rs,
 * identical for MainAlbatross and TestAlbatross). Once the chain has moved
 * past that window from a WAL vsh, a transaction carrying it can NEVER be
 * included — a stuck 'dispatching' row older than that is provably dead and
 * safe to fail for a re-plan with a FRESH vsh (nothing from it is in flight
 * on-chain). Re-planning EARLIER than this would be unsafe: a tx broadcast
 * under the recorded vsh could still be sitting in mempools waiting to mine.
 */

import {
  getCanonicalTreasuryAddress,
  NIMIQ_NETWORK,
  networkIdToName,
} from "@/lib/nimiq/config";
import { getNimiqPayoutConfig } from "@/lib/server/nimiq/payout-config";
import {
  NimiqRpcError,
  getBlockNumber,
  getTransactionByHash,
  isAccountUnlocked,
  sendBasicTransaction,
} from "@/lib/server/nimiq/rpc";
import { canonicalAddress } from "@/lib/server/nimiq/verify";
import {
  PayoutTransitionError,
  fastStorePayoutStore,
  mirrorPayouts,
  type PayoutRecord,
  type PayoutStore,
  type TreasurySigner,
} from "@/lib/server/tournament-payouts";

/** Re-plan a stuck WAL row once the chain is this far past its vsh. */
const VSH_STALENESS_BLOCKS = 7_200; // 120 validity-window batches × 60 blocks per batch

/** Payout fee: 0 luna (Albatross has no protocol-mandated minimum fee). */
const PAYOUT_FEE_LUNA = 0n;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type PayoutDispatchErrorKind =
  | "configuration-error" // signer not configured / misconfigured
  | "rpc-unavailable" // payout node unreachable
  | "wallet-locked" // keystore wallet not unlocked
  | "broadcast-failed" // node refused the broadcast / verification mismatch
  | "malformed-response" // node answered nonsense
  | "reconciliation-required"; // WAIT: dispatch mid-flight, retry later

const STATUS_BY_KIND: Record<PayoutDispatchErrorKind, number> = {
  "configuration-error": 503,
  "rpc-unavailable": 503,
  "wallet-locked": 503,
  "broadcast-failed": 502,
  "malformed-response": 502,
  "reconciliation-required": 409,
};

export class PayoutDispatchError extends Error {
  readonly kind: PayoutDispatchErrorKind;
  readonly status: number;
  constructor(kind: PayoutDispatchErrorKind, message: string) {
    super(message);
    this.name = "PayoutDispatchError";
    this.kind = kind;
    this.status = STATUS_BY_KIND[kind];
  }
}

/* ------------------------------------------------------------------ */
/* The RPC-backed TreasurySigner                                       */
/* ------------------------------------------------------------------ */

export interface RpcSignerDeps {
  sendBasicTransaction?: typeof sendBasicTransaction;
  getBlockNumber?: typeof getBlockNumber;
  isAccountUnlocked?: typeof isAccountUnlocked;
  /** Health-check unlock state before sending (default true). */
  checkUnlocked?: boolean;
}

/**
 * Build the real signer from the payout-node config. Returns null when
 * payout dispatch is deliberately unconfigured (the typed-off 2B default).
 * Throws NimiqPayoutConfigError for MISconfiguration.
 */
export function buildRpcTreasurySigner(
  deps: RpcSignerDeps = {},
): TreasurySigner | null {
  const config = getNimiqPayoutConfig();
  if (!config) return null;

  // H4 — fail closed: the payout node's treasury and the ENTRY treasury
  // must be the same address. A divergence would mean players pay into one
  // treasury while prizes leave another (accounting can never balance), so
  // misconfiguration here disables dispatch entirely rather than paying out
  // of an unaccounted wallet. When the entry treasury is simply not yet
  // configured there is nothing to diverge FROM — 1C already refuses entry
  // verification in that state, so dispatch construction is allowed.
  const entryTreasury = canonicalAddress(getCanonicalTreasuryAddress());
  if (entryTreasury && canonicalAddress(config.treasuryAddress) !== entryTreasury) {
    throw new PayoutDispatchError(
      "configuration-error",
      `Treasury mismatch: NIMIQ_PAYOUT_TREASURY_ADDRESS (${config.treasuryAddress}) differs from the entry treasury (${entryTreasury}) — refusing to dispatch payouts`,
    );
  }

  const send = deps.sendBasicTransaction ?? sendBasicTransaction;
  const heightOf = deps.getBlockNumber ?? getBlockNumber;
  const unlocked = deps.isAccountUnlocked ?? isAccountUnlocked;
  const overrides = {
    url: config.url,
    basicAuth: config.basicAuth,
    timeoutMs: 15_000,
  };

  return {
    getSenderAddress(): string | null {
      return config.treasuryAddress;
    },
    async getChainHeight(): Promise<number> {
      try {
        const h = await heightOf(overrides);
        if (typeof h !== "number" || !Number.isFinite(h) || h < 0) {
          throw new PayoutDispatchError(
            "malformed-response",
            "Node returned an invalid block height",
          );
        }
        return h;
      } catch (err) {
        if (err instanceof PayoutDispatchError) throw err;
        if (err instanceof NimiqRpcError) {
          throw new PayoutDispatchError(
            "rpc-unavailable",
            "Could not reach the payout node to read the chain height",
          );
        }
        throw err;
      }
    },
    async sendPayout(address: string, amountLuna: bigint, validityStartHeight?: number): Promise<string> {
      try {
        if (deps.checkUnlocked !== false) {
          let isUnlocked: boolean;
          try {
            isUnlocked = await unlocked(config.treasuryAddress, overrides);
          } catch {
            throw new PayoutDispatchError(
              "rpc-unavailable",
              "Could not reach the payout node to check the treasury wallet",
            );
          }
          if (typeof isUnlocked !== "boolean") {
            throw new PayoutDispatchError(
              "malformed-response",
              "Node returned a non-boolean unlock state",
            );
          }
          if (!isUnlocked) {
            throw new PayoutDispatchError(
              "wallet-locked",
              "The treasury wallet is locked on the payout node — unlock it and retry",
            );
          }
        }

        const height = await heightOf(overrides);
        if (typeof height !== "number" || !Number.isFinite(height) || height < 0) {
          throw new PayoutDispatchError(
            "malformed-response",
            "Node returned an invalid block height",
          );
        }

        // Broadcast at the caller-pinned vsh when given (crash recovery MUST
        // re-use the recorded one so the tx — and its hash — is identical);
        // otherwise draw a fresh one at the current height.
        const vsh =
          typeof validityStartHeight === "number" && validityStartHeight >= 0
            ? validityStartHeight
            : Math.floor(height);

        return await send(
          config.treasuryAddress,
          address,
          amountLuna,
          PAYOUT_FEE_LUNA,
          vsh,
          overrides,
        );
      } catch (err) {
        if (err instanceof PayoutDispatchError) throw err;
        if (err instanceof NimiqRpcError) {
          throw new PayoutDispatchError(
            "rpc-unavailable",
            `Payout node error: ${err.message}`,
          );
        }
        throw new PayoutDispatchError(
          "broadcast-failed",
          `Payout broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Crash-safe dispatch protocol                                        */
/* ------------------------------------------------------------------ */

export interface DispatchPayoutDeps {
  store?: PayoutStore;
  signer?: TreasurySigner | null;
  /** Current chain height (defaults to the payout node). */
  getHeight?: () => Promise<number>;
  now?: () => number;
}

/**
 * Dispatch a planned payout with full crash safety.
 *
 * Guarantees:
 *  - NEVER dispatches a payout that is 'sent' or 'verified' (idempotent no-op)
 *  - concurrent callers serialize (per-payout lock inside the store layer)
 *  - a crash anywhere leaves a durable trail that recovery resolves to
 *    EXACTLY ONE effective on-chain payment
 */
export async function dispatchPayout(
  tournamentId: string,
  playerId: string,
  deps: DispatchPayoutDeps = {},
): Promise<PayoutRecord> {
  const store = deps.store ?? fastStorePayoutStore;
  const signer = deps.signer !== undefined ? deps.signer : buildRpcTreasurySigner();

  if (!signer) {
    throw new PayoutTransitionError(
      "No treasury signer is configured — payouts are recorded but not dispatched",
      503,
    );
  }

  // Serialize per payout (same lock family the 2B transitions use).
  const { withPayoutLock } = await import("@/lib/server/tournament-payouts");
  return withPayoutLock(`send:${tournamentId}:${playerId}`, () =>
    dispatchLocked(store, signer, tournamentId, playerId, deps),
  );
}

/** Internal: assumes the per-payout lock is already held. */
async function dispatchLocked(
  store: PayoutStore,
  signer: TreasurySigner,
  tournamentId: string,
  playerId: string,
  deps: DispatchPayoutDeps,
): Promise<PayoutRecord> {
  const now = deps.now ?? Date.now;
  const payout = await store.get(tournamentId, playerId);
  if (!payout) throw new PayoutTransitionError("Payout record not found", 404);

  // Idempotency: already dispatched — never re-send.
  if (payout.status === "sent" || payout.status === "verified") {
    return payout;
  }
  if (payout.status === "blocked_no_wallet") {
    throw new PayoutTransitionError(
      "Winner has no linked Nimiq wallet — they must link one first",
      409,
    );
  }
  if (!payout.destinationAddress) {
    throw new PayoutTransitionError("Payout has no destination address", 409);
  }

  // --- crash recovery: a mid-flight dispatch gets RE-SENT, not re-planned ---
  if (payout.status === "dispatching") {
    if (
      payout.senderAddress == null ||
      payout.validityStartHeight == null ||
      !payout.amountLuna
    ) {
      // Not a complete WAL row: cannot recover deterministically.
      const failed: PayoutRecord = {
        ...payout,
        status: "failed",
        failureReason: "Incomplete dispatch intent — manual reconciliation required",
      };
      await store.upsert(failed);
      throw new PayoutTransitionError(
        "Incomplete dispatch intent — manual reconciliation required",
        409,
      );
    }

    const age = (await currentHeight(deps, signer)) - payout.validityStartHeight;
    if (age > VSH_STALENESS_BLOCKS) {
      // The WAL vsh is provably dead: nothing broadcast under it can ever
      // mine (120-batch × 60-block validity window has fully passed).
      const failed: PayoutRecord = {
        ...payout,
        status: "failed",
        failureReason: "Dispatch intent expired (validity window passed) — retry to re-plan",
      };
      await store.upsert(failed);
      throw new PayoutTransitionError(
        "Dispatch intent expired — retry to re-plan with a fresh validity window",
        409,
      );
    }

    // Re-broadcast with the SAME recorded fields → byte-identical tx → same
    // hash → chain dedupes. This is the heart of the crash-safety proof.
    return broadcastAndFinalize(store, payout, payout.validityStartHeight, signer, now(), true);
  }

  // status 'pending' or 'failed' → fresh dispatch: WRITE-AHEAD first.
  const vsh = await currentHeight(deps, signer);
  const intent: PayoutRecord = {
    ...payout,
    status: "dispatching",
    network: payout.network ?? "test",
    senderAddress: signer.getSenderAddress?.() ?? null,
    validityStartHeight: vsh,
    dispatchAttempts: (payout.dispatchAttempts ?? 0) + 1,
    lastBroadcastAt: null,
    failureReason: null,
  };
  await store.upsert(intent);

  return broadcastAndFinalize(store, intent, vsh, signer, now(), false);
}

/** Broadcast with the given (reused or fresh) vsh and persist the outcome. */
async function broadcastAndFinalize(
  store: PayoutStore,
  payout: PayoutRecord,
  vsh: number,
  signer: TreasurySigner,
  nowMs: number,
  isRecovery: boolean,
): Promise<PayoutRecord> {
  let txHash: string;
  try {
    txHash = await signer.sendPayout(
      payout.destinationAddress as string,
      BigInt(payout.amountLuna),
      vsh,
    );
  } catch (err) {
    // Broadcast (or health-check) failed. The WAL row stays 'dispatching' —
    // the intent stands and recovery is deterministic. Surface typed errors.
    if (err instanceof PayoutDispatchError || err instanceof PayoutTransitionError) {
      throw err;
    }
    throw new PayoutDispatchError(
      "broadcast-failed",
      `Payout broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new PayoutDispatchError(
      "malformed-response",
      "Signer returned no usable transaction hash",
    );
  }
  const sent: PayoutRecord = {
    ...payout,
    status: "sent",
    payoutTxHash: txHash,
    sentAt: nowMs,
    lastBroadcastAt: nowMs,
    validityStartHeight: payout.validityStartHeight ?? vsh,
    // A recovery re-broadcast is another real attempt — count it.
    dispatchAttempts: isRecovery ? (payout.dispatchAttempts ?? 0) + 1 : payout.dispatchAttempts,
    failureReason: null,
  };
  await store.upsert(sent);
  await mirrorPayouts(payout.tournamentId, [sent]);
  return sent;
}/**
 * Current chain height: prefer the signer's own node accessor (an injected
 * signer always knows its node), falling back to the payout-node env config.
 */
async function currentHeight(
  deps: DispatchPayoutDeps,
  signer?: TreasurySigner,
): Promise<number> {
  if (deps.getHeight) return deps.getHeight();
  if (signer?.getChainHeight) return signer.getChainHeight();
  const config = getNimiqPayoutConfig();
  if (!config) {
    throw new PayoutTransitionError(
      "No treasury signer is configured — payouts are recorded but not dispatched",
      503,
    );
  }
  try {
    const h = await getBlockNumber({
      url: config.url,
      basicAuth: config.basicAuth,
      timeoutMs: 10_000,
    });
    if (typeof h !== "number" || !Number.isFinite(h) || h < 0) {
      throw new PayoutDispatchError(
        "malformed-response",
        "Node returned an invalid block height",
      );
    }
    return h;
  } catch (err) {
    if (err instanceof PayoutDispatchError) throw err;
    throw new PayoutDispatchError(
      "rpc-unavailable",
      "Could not reach the payout node to read the chain height",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Real on-chain verification of an outgoing payout                    */
/* ------------------------------------------------------------------ */

export interface VerifyOutgoingDeps {
  store?: PayoutStore;
  getTransactionByHash?: typeof getTransactionByHash;
  getBlockNumber?: typeof getBlockNumber;
  now?: () => number;
  /** Confirmations required (defaults to NIMIQ_PAYOUT_CONFIRMATIONS_REQUIRED). */
  confirmationsRequired?: number;
}

/**
 * Verify an outgoing payout on-chain and mark it VERIFIED only when the REAL
 * transaction matches the payout record exactly: sender == configured
 * treasury, recipient == payout destination, value == exact payout amount,
 * execution succeeded, and confirmations >= required.
 *
 * Same inclusive boundary as Phase 1C: confirmations = height − block + 1.
 */
export async function verifyOutgoingPayout(
  tournamentId: string,
  playerId: string,
  deps: VerifyOutgoingDeps = {},
): Promise<PayoutRecord> {
  const store = deps.store ?? fastStorePayoutStore;
  const now = deps.now ?? Date.now;

  const payout = await store.get(tournamentId, playerId);
  if (!payout) throw new PayoutTransitionError("Payout record not found", 404);
  if (payout.status === "verified") return payout;
  if (payout.status !== "sent" || !payout.payoutTxHash) {
    throw new PayoutTransitionError(
      "Only a sent payout with a real transaction hash can be verified",
      409,
    );
  }

  const config = getNimiqPayoutConfig();
  const required = deps.confirmationsRequired ?? config?.confirmationsRequired ?? 10;

  const fetchTx = deps.getTransactionByHash ?? getTransactionByHash;
  const heightOf = deps.getBlockNumber ?? getBlockNumber;
  const overrides = {
    url: config?.url,
    basicAuth: config?.basicAuth,
    timeoutMs: 10_000,
  };

  let tx: Awaited<ReturnType<typeof getTransactionByHash>>;
  try {
    tx = await fetchTx(payout.payoutTxHash, overrides);
  } catch (err) {
    if (err instanceof NimiqRpcError) {
      throw new PayoutDispatchError(
        "rpc-unavailable",
        "Could not reach the node to verify the payout transaction",
      );
    }
    throw err;
  }

  if (!tx || typeof tx !== "object" || !tx.hash) {
    // The hash we hold came from the node itself; absence here is abnormal.
    throw new PayoutDispatchError(
      "malformed-response",
      "The payout transaction is not visible on the node yet",
    );
  }

  const expectedSender = canonicalAddress(
    // The treasury of record: env config when present, otherwise the sender
    // recorded in the write-ahead row at dispatch time (never client data).
    config?.treasuryAddress ?? payout.senderAddress ?? "",
  );
  const sender = canonicalAddress(String(tx.from ?? ""));
  if (!expectedSender || sender !== expectedSender) {
    throw new PayoutDispatchError(
      "broadcast-failed",
      "Payout transaction sender does not match the configured treasury",
    );
  }
  if (!payout.destinationAddress) {
    throw new PayoutTransitionError("Payout has no destination address", 409);
  }
  const recipient = canonicalAddress(String(tx.to ?? ""));
  if (recipient !== canonicalAddress(payout.destinationAddress)) {
    throw new PayoutDispatchError(
      "broadcast-failed",
      "Payout transaction recipient does not match the payout destination",
    );
  }
  let onChainLuna: bigint;
  try {
    onChainLuna = BigInt(tx.value);
  } catch {
    throw new PayoutDispatchError(
      "malformed-response",
      "Node returned a non-integer transaction value",
    );
  }
  if (onChainLuna !== BigInt(payout.amountLuna)) {
    throw new PayoutDispatchError(
      "broadcast-failed",
      "Payout transaction amount does not match the payout record",
    );
  }
  // Execution verdict from the current RPC's explicit `executionResult`
  // field (the old flags-bit heuristic misread the protocol's SIGNALING
  // flag). Fail closed: no boolean verdict → malformed response.
  const executionResult = (tx as { executionResult?: unknown }).executionResult;
  if (typeof executionResult !== "boolean") {
    throw new PayoutDispatchError(
      "malformed-response",
      "Node response has no executionResult — payout outcome cannot be established, refusing verification",
    );
  }
  if (!executionResult) {
    throw new PayoutDispatchError(
      "broadcast-failed",
      "Payout transaction failed on-chain execution",
    );
  }

  // M1 — fail closed: the payout network identity MUST be present, known,
  // and equal to the deployment network. A node answer without usable
  // network information can never verify a payout.
  const txNetworkId = (tx as { networkId?: unknown }).networkId;
  const expectedNetwork = payout.network ?? NIMIQ_NETWORK;
  const expectedId = expectedNetwork === "main" ? 42 : 5;
  if (typeof txNetworkId !== "number") {
    throw new PayoutDispatchError(
      "malformed-response",
      "Node response has no networkId — payout network cannot be established, refusing verification",
    );
  }
  const knownNetwork = networkIdToName(txNetworkId);
  if (!knownNetwork) {
    throw new PayoutDispatchError(
      "broadcast-failed",
      `Payout transaction networkId ${txNetworkId} is not a known Nimiq network`,
    );
  }
  if (txNetworkId !== expectedId) {
    throw new PayoutDispatchError(
      "broadcast-failed",
      `Payout transaction is on networkId ${txNetworkId} (${knownNetwork}), expected ${expectedId} (${expectedNetwork})`,
    );
  }
  if (typeof tx.blockNumber !== "number" || tx.blockNumber < 0) {
    // Not yet mined — retry later; nothing is marked verified.
    throw new PayoutDispatchError(
      "reconciliation-required",
      "Payout transaction is not yet included in a block — retry shortly",
    );
  }

  let height: number;
  try {
    height = await heightOf(overrides);
  } catch (err) {
    if (err instanceof NimiqRpcError) {
      throw new PayoutDispatchError(
        "rpc-unavailable",
        "Could not reach the node to read the chain height",
      );
    }
    throw err;
  }
  const confirmations = height - tx.blockNumber + 1;
  if (confirmations < required) {
    throw new PayoutDispatchError(
      "reconciliation-required",
      `Payout has ${Math.max(confirmations, 0)} confirmations, ${required} required`,
    );
  }

  const verified: PayoutRecord = {
    ...payout,
    status: "verified",
    verifiedAt: now(),
  };
  await store.upsert(verified);
  await mirrorPayouts(payout.tournamentId, [verified]);
  return verified;
}

/* ------------------------------------------------------------------ */
/* Reconciliation sweep — recovery entry point (cron / manual / boot)  */
/* ------------------------------------------------------------------ */

export interface ReconcileResult {
  reconciled: number;
  expired: number;
  pending: number;
}

/**
 * Resolve every mid-flight ('dispatching') payout for a tournament. Safe to
 * call repeatedly and concurrently: each row is processed under its own
 * per-payout lock, and every resolution path is deterministic (re-broadcast
 * same vsh, or expire a provably-dead intent).
 */
export async function reconcileDispatchingPayouts(
  tournamentId: string,
  deps: DispatchPayoutDeps = {},
): Promise<ReconcileResult> {
  const store = deps.store ?? fastStorePayoutStore;
  const signer = deps.signer !== undefined ? deps.signer : buildRpcTreasurySigner();
  if (!signer) {
    throw new PayoutTransitionError(
      "No treasury signer is configured — nothing to reconcile",
      503,
    );
  }

  const rows = await store.listByTournament(tournamentId);
  let reconciled = 0;
  let expired = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.status !== "dispatching") {
      if (row.status === "pending" || row.status === "failed") pending += 1;
      continue;
    }
    try {
      await dispatchPayout(row.tournamentId, row.playerId, { ...deps, store, signer });
      reconciled += 1;
    } catch (err) {
      if (err instanceof PayoutTransitionError && /expired/i.test(err.message)) {
        expired += 1;
      } else {
        pending += 1; // still in flight or node down — try again later
      }
    }
  }
  return { reconciled, expired, pending };
}
