// Server-only module — never import from client components.

/**
 * Prize-pool withdrawals — the operator takes UNCOMMITTED pool money out.
 *
 * The exact REVERSE of a top-up (tournament-topup.ts): instead of verifying
 * money the admin paid INTO the treasury, the treasury payout node SENDS
 * money OUT to the admin's linked wallet, through the same crash-safe
 * dispatch protocol prizes use (tournament-payouts-dispatch.ts):
 *
 *   1. WRITE-AHEAD: persist status='dispatching' + sender + amount + vsh
 *      BEFORE any broadcast.
 *   2. Broadcast with that recorded vsh (deterministic re-broadcast on
 *      recovery → byte-identical tx → same hash → chain dedupes).
 *   3. Persist the returned hash → 'sent'.
 *   4. Verify on-chain (sender/recipient/value/success/confirmations) →
 *      'verified'.
 *
 * THE CAP — players' money can never be withdrawn:
 *   available = verified pool
 *             − every planned payout row (a planned purse is committed,
 *               whatever its status — pending/failed rows are still owed)
 *             − every refund obligation not yet verified
 *             − every refund the treasury itself paid out (the pool ledger
 *               only ever counts money IN, so treasury-paid refunds are
 *               subtracted here from the on-chain consumption rows)
 *             − every prior withdrawal in flight or settled
 *   A withdrawal larger than that is refused, so prizes and refunds stay
 *   fully funded no matter what the operator asks to pull out.
 *
 * WHEN: only a LIVE tournament lets money leave — the operator may pull
 * uncommitted surplus out of a running event (top-ups that outgrew the
 * field), exactly as a top-up only goes INTO a live event. An ENDED one
 * refuses withdrawals: its pool is fully spoken for by prizes and refunds,
 * so there is nothing legitimately uncommitted to take.
 * On a completed PAID tournament the purse-cut rule still applies: the
 * operator is told to distribute first, so the whole prize can never be
 * withdrawn before it is even planned.
 *
 * WHO: ChainMate only (the same accountable-money-mover rule as payouts),
 * and the destination is ALWAYS the admin's own linked wallet — the server
 * resolves it, the client can never type one in.
 */

import { getTournamentDoc } from "@/lib/server/tournament-store";
import {
  NIMIQ_NETWORK,
  getCanonicalTreasuryAddress,
  nimiqNetworkId,
  networkIdToName,
  type NimiqNetworkName,
} from "@/lib/nimiq/config";
import { canonicalAddress } from "@/lib/nimiq/address";
import { getNimiqPayoutConfig } from "@/lib/server/nimiq/payout-config";
import { fastStoreTxStore, type NimiqTxStore } from "@/lib/server/nimiq/transactions";
import {
  fastStorePayoutStore,
  withPayoutLock,
  type PayoutStore,
  type TreasurySigner,
} from "@/lib/server/tournament-payouts";
import { getGameStorage } from "@/lib/server/storage";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class WithdrawError extends Error {
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, message: string, status = 400) {
    super(message);
    this.name = "WithdrawError";
    this.kind = kind;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type WithdrawStatus = "dispatching" | "sent" | "verified" | "failed";

/**
 * One withdrawal. Field names mirror PayoutRecord's dispatch metadata so
 * the WAL/verify semantics read identically across both ledgers.
 */
export interface WithdrawRecord {
  id: string;
  tournamentId: string;
  /** Exact luna, digits-only string (durable format). */
  amountLuna: string;
  /** The admin's linked wallet — resolved server-side, never typed in. */
  recipientAddress: string;
  network: NimiqNetworkName;
  status: WithdrawStatus;
  /** Real outgoing treasury tx hash; null until broadcast. Never faked. */
  withdrawTxHash: string | null;
  /** Treasury address the payout node signs from (write-ahead metadata). */
  senderAddress: string | null;
  /** WRITE-AHEAD: recorded BEFORE broadcast; reused on every recovery. */
  validityStartHeight: number | null;
  dispatchAttempts: number;
  lastBroadcastAt: number | null;
  failureReason: string | null;
  requestedAt: number;
  sentAt: number | null;
  verifiedAt: number | null;
}

/** What the admin console shows before asking for money. */
export interface WithdrawQuote {
  poolLuna: string;
  /** Locked by planned payouts, owed refunds, and prior withdrawals. */
  committedLuna: string;
  /** The only amount a withdrawal may take. */
  availableLuna: string;
  /** The admin's linked wallet — where a withdrawal would land. */
  recipientAddress: string | null;
  network: NimiqNetworkName;
  /** Whether this deployment's payout node can sign a withdrawal at all. */
  signerConfigured: boolean;
}

export interface WithdrawResult {
  amountLuna: string;
  status: WithdrawStatus;
  withdrawTxHash: string | null;
  recipientAddress: string;
  /** Uncommitted pool remaining after this withdrawal (or recovery). */
  availableLunaAfter: string;
}

/* ------------------------------------------------------------------ */
/* Storage — durable withdrawal ledger (project storage)               */
/* ------------------------------------------------------------------ */

interface WithdrawalsFile {
  withdrawals: Record<string, WithdrawRecord[]>;
}

const WITHDRAWALS_KEY = "chainmate:withdrawals";

export interface WithdrawStore {
  listByTournament(tournamentId: string): Promise<WithdrawRecord[]>;
  append(row: WithdrawRecord): Promise<void>;
  /** Full replace by row id (WAL transitions). */
  replace(row: WithdrawRecord): Promise<void>;
}

async function readWithdrawalsFile(): Promise<WithdrawalsFile> {
  try {
    const raw = await getGameStorage().get(WITHDRAWALS_KEY);
    if (!raw) return { withdrawals: {} };
    const parsed = JSON.parse(raw) as WithdrawalsFile;
    return parsed?.withdrawals ? parsed : { withdrawals: {} };
  } catch {
    return { withdrawals: {} };
  }
}

async function writeWithdrawalsFile(file: WithdrawalsFile): Promise<void> {
  await getGameStorage().set(WITHDRAWALS_KEY, JSON.stringify(file));
}

export const fastStoreWithdrawStore: WithdrawStore = {
  async listByTournament(tournamentId) {
    const file = await readWithdrawalsFile();
    return [...(file.withdrawals[tournamentId] ?? [])].sort((a, b) => a.requestedAt - b.requestedAt);
  },
  async append(row) {
    const file = await readWithdrawalsFile();
    const rows = file.withdrawals[row.tournamentId] ?? [];
    rows.push(row);
    file.withdrawals[row.tournamentId] = rows;
    await writeWithdrawalsFile(file);
  },
  async replace(row) {
    const file = await readWithdrawalsFile();
    const rows = file.withdrawals[row.tournamentId] ?? [];
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    file.withdrawals[row.tournamentId] = rows;
    await writeWithdrawalsFile(file);
  },
};

/** The tournament's withdrawal history (oldest first) — UI/admin reader. */
export async function listPoolWithdrawals(
  tournamentId: string,
  store: WithdrawStore = fastStoreWithdrawStore,
): Promise<WithdrawRecord[]> {
  return store.listByTournament(tournamentId);
}

/* ------------------------------------------------------------------ */
/* Seams                                                               */
/* ------------------------------------------------------------------ */

export interface WithdrawDeps {
  getDoc?: typeof getTournamentDoc;
  isAdmin?: (playerId: string) => Promise<boolean>;
  getTreasuryAddress?: () => string;
  getLinkedWallet?: (playerId: string) => Promise<{ address: string; network: string } | null>;
  /** Injected signer (tests); defaults to the payout-node RPC signer. */
  signer?: TreasurySigner | null;
  store?: WithdrawStore;
  payoutStore?: PayoutStore;
  txStore?: NimiqTxStore;
  now?: () => number;
  /** Confirmations required before a withdrawal counts as settled. */
  confirmationsRequired?: number;
  getTransactionByHash?: (hash: string, overrides?: Record<string, unknown>) => Promise<unknown>;
  getBlockNumber?: (overrides?: Record<string, unknown>) => Promise<number>;
}

async function adminGate(deps: WithdrawDeps | undefined, playerId: string): Promise<boolean> {
  if (deps?.isAdmin) return deps.isAdmin(playerId);
  const { isAdminPlayer } = await import("@/lib/server/admin");
  return isAdminPlayer(playerId);
}

/**
 * Resolve the real signer from the payout-node config. Returns null when
 * payout dispatch is deliberately unconfigured; PayoutDispatchError (e.g. a
 * treasury mismatch) propagates — a misconfigured signer must not silently
 * disable withdrawals, it must surface.
 */
async function resolveSigner(deps: WithdrawDeps): Promise<TreasurySigner | null> {
  if (deps.signer !== undefined) return deps.signer;
  const { buildRpcTreasurySigner } = await import("@/lib/server/tournament-payouts-dispatch");
  return buildRpcTreasurySigner();
}

/* ------------------------------------------------------------------ */
/* The cap — uncommitted pool funds                                    */
/* ------------------------------------------------------------------ */

/**
 * How much of the pool is NOT promised to anyone: planned payouts (every
 * row, whatever its status — pending/failed prizes are still owed), refunds
 * not yet settled, refunds the treasury itself paid, and withdrawals in
 * flight or already settled. Never a client number; every term is read
 * from the durable ledgers.
 */
export async function availablePoolLuna(
  tournamentId: string,
  deps: WithdrawDeps = {},
): Promise<{ poolLuna: bigint; committedLuna: bigint; availableLuna: bigint }> {
  const txStore = deps.txStore ?? fastStoreTxStore;
  const payoutStore = deps.payoutStore ?? fastStorePayoutStore;

  const { getVerifiedPrizePool } = await import("@/lib/server/tournament-economy");
  const poolLuna = await getVerifiedPrizePool(tournamentId, txStore);

  let committed = 0n;

  // Prior withdrawals — money already out or wired to go out.
  const withdrawStore = deps.store ?? fastStoreWithdrawStore;
  const withdrawals = await withdrawStore.listByTournament(tournamentId).catch(() => []);
  for (const w of withdrawals) {
    if (w.status === "dispatching" || w.status === "sent" || w.status === "verified") {
      committed += BigInt(w.amountLuna);
    }
  }

  // Planned payouts — a planned purse is committed whatever its state.
  const payouts = await payoutStore.listByTournament(tournamentId).catch(() => []);
  for (const p of payouts) {
    committed += BigInt(p.amountLuna);
  }

  // Refund obligations not yet settled (owed | dispatched | failed).
  const doc = await (deps.getDoc ?? getTournamentDoc)(tournamentId);
  if (doc?.refunds) {
    for (const r of Object.values(doc.refunds)) {
      if (r.status !== "verified") committed += BigInt(r.amountLuna);
    }
  }

  // Refunds the TREASURY itself paid (the sweep path, when a signer
  // exists): the pool ledger only counts money IN, so subtract these from
  // the on-chain consumption rows. Host-wallet refunds (this deployment's
  // default) never touch the treasury and are excluded by the sender check
  // — and they are already excluded above while unverified, so a refund is
  // counted exactly once no matter which path settled it.
  if (doc && txStore.listByTournament) {
    const treasury = (deps.getTreasuryAddress ?? getCanonicalTreasuryAddress)();
    if (treasury) {
      const treasuryAddr = canonicalAddress(treasury);
      const verifiedHashes = new Set(
        Object.values(doc.refunds ?? {})
          .filter((r) => r.status === "verified" && r.refundTxHash)
          .map((r) => r.refundTxHash as string),
      );
      const rows = await txStore.listByTournament(tournamentId).catch(() => []);
      for (const row of rows) {
        if (row.kind === "refund" && verifiedHashes.has(row.txHash)) {
          if (canonicalAddress(row.sender) === treasuryAddr) {
            committed += BigInt(row.amountLuna);
          }
        }
      }
    }
  }

  const availableLuna = poolLuna > committed ? poolLuna - committed : 0n;
  return { poolLuna, committedLuna: committed, availableLuna };
}

/* ------------------------------------------------------------------ */
/* Quote — what the console shows before asking for money              */
/* ------------------------------------------------------------------ */

/**
 * Read-only view for the admin console: the pool, what is locked, what may
 * leave, and whether this deployment can sign a withdrawal at all.
 * Admin-only — pool internals are not public data.
 */
export async function quotePoolWithdrawal(
  tournamentId: string,
  adminPlayerId: string,
  deps: WithdrawDeps = {},
): Promise<WithdrawQuote> {
  if (!(await adminGate(deps, adminPlayerId))) {
    throw new WithdrawError("not-admin", "Only ChainMate can view pool withdrawal details", 403);
  }
  const doc = await (deps.getDoc ?? getTournamentDoc)(tournamentId);
  if (!doc) throw new WithdrawError("not-found", "Tournament not found", 404);

  const { getLinkedWallet } = await import("@/lib/server/nimiq/service");
  const wallet = deps.getLinkedWallet
    ? await deps.getLinkedWallet(adminPlayerId).catch(() => null)
    : await getLinkedWallet(adminPlayerId).catch(() => null);

  let signerConfigured = true;
  try {
    const signer = await resolveSigner(deps);
    if (!signer) {
      signerConfigured = false;
    } else if (signer.canSign) {
      // A configured RPC endpoint may still be a read-only proxy that cannot
      // broadcast — probe it so the console reports the truth up front.
      signerConfigured = await signer.canSign();
    }
  } catch {
    signerConfigured = false; // misconfigured signer = cannot sign
  }

  const { poolLuna, committedLuna, availableLuna } = await availablePoolLuna(tournamentId, deps);
  return {
    poolLuna: poolLuna.toString(),
    committedLuna: committedLuna.toString(),
    availableLuna: availableLuna.toString(),
    recipientAddress: wallet?.address ?? null,
    network: NIMIQ_NETWORK,
    signerConfigured,
  };
}

/* ------------------------------------------------------------------ */
/* Withdraw                                                            */
/* ------------------------------------------------------------------ */

/**
 * Withdraw uncommitted pool funds to the admin's linked wallet.
 *
 * Crash-safe exactly like prize dispatch: a WAL intent is persisted before
 * any broadcast, a recovery re-broadcast reuses the recorded vsh (same tx,
 * same hash), and only the real returned hash flips the row to 'sent'.
 */
export async function withdrawPool(
  tournamentId: string,
  adminPlayerId: string,
  amountNim: string,
  deps: WithdrawDeps = {},
): Promise<WithdrawResult> {
  const store = deps.store ?? fastStoreWithdrawStore;
  const now = deps.now ?? Date.now;

  return withPayoutLock(`withdraw:${tournamentId}`, async () => {
    // Only ChainMate moves pool money out — same accountable-mover rule.
    if (!(await adminGate(deps, adminPlayerId))) {
      throw new WithdrawError("not-admin", "Only ChainMate can withdraw from a prize pool", 403);
    }

    const doc = await (deps.getDoc ?? getTournamentDoc)(tournamentId);
    if (!doc) throw new WithdrawError("not-found", "Tournament not found", 404);

    // Money only leaves a LIVE event — the mirror image of the top-up rule
    // (top-ups go INTO live events only; withdrawals come OUT of them only).
    // An ended event's pool is fully committed to prizes and refunds.
    if (doc.status === "completed" || doc.status === "cancelled") {
      throw new WithdrawError(
        "tournament-ended",
        doc.status === "completed"
          ? "This tournament has ended — its pool belongs to the prizes. Withdrawals only work on live events."
          : "This tournament was cancelled — its pool is being refunded. Withdrawals only work on live events.",
        409,
      );
    }

    // Destination: the admin's own linked wallet, resolved server-side.
    const { getLinkedWallet } = await import("@/lib/server/nimiq/service");
    const wallet = deps.getLinkedWallet
      ? await deps.getLinkedWallet(adminPlayerId).catch(() => null)
      : await getLinkedWallet(adminPlayerId).catch(() => null);
    if (!wallet?.address) {
      throw new WithdrawError(
        "no-recipient",
        "Link a Nimiq wallet to your ChainMate account first — withdrawals go to the linked wallet",
      );
    }
    const recipient = canonicalAddress(wallet.address);

    const signer = await resolveSigner(deps);
    if (!signer) {
      throw new WithdrawError(
        "no-signer",
        "Pool withdrawals send from the treasury payout node, which is not configured on this deployment",
        503,
      );
    }

    const withdrawals = await store.listByTournament(tournamentId);
    const active = withdrawals.find((w) => w.status === "dispatching" || w.status === "sent");

    // A 'sent' withdrawal is on chain awaiting confirmations — resolve it,
    // never re-withdraw.
    if (active?.status === "sent") {
      throw new WithdrawError(
        "withdrawal-in-flight",
        "A withdrawal is already in flight — check status before withdrawing again",
        409,
      );
    }

    // Crash recovery: a mid-flight WAL row gets RE-BROADCAST with the same
    // recorded fields (byte-identical tx, same hash), not re-planned. The
    // requested amount is ignored — the row's amount is what was committed.
    if (active?.status === "dispatching") {
      // A dead endpoint must not loop: recovery re-broadcasts with the
      // recorded fields, which fails identically forever on a read-only
      // proxy. If this endpoint provably cannot sign, the intent is dead —
      // settle it as failed and tell the operator why, nothing stuck.
      if (signer.canSign && !(await signer.canSign())) {
        await store.replace({
          ...active,
          status: "failed",
          failureReason: "Payout endpoint cannot sign transactions — configure a signing node, then withdraw again",
        });
        throw new WithdrawError(
          "no-signer",
          "This deployment's payout endpoint can't sign transactions — the pending withdrawal was cancelled; configure a signing node and try again",
          503,
        );
      }
      const staleVsh =
        typeof active.validityStartHeight === "number" &&
        (await currentHeight(deps, signer)) - active.validityStartHeight > VSH_STALENESS_BLOCKS;
      if (
        active.senderAddress == null ||
        active.validityStartHeight == null ||
        !active.amountLuna ||
        staleVsh
      ) {
        // Dead intent: provably nothing deterministic can recover it.
        await store.replace({
          ...active,
          status: "failed",
          failureReason: staleVsh
            ? "Dispatch intent expired (validity window passed), withdraw again"
            : "Incomplete dispatch intent, withdraw again",
        });
      } else {
        const sent = await broadcastAndFinalize(store, active, active.validityStartHeight, signer, now(), true);
        const { availableLuna } = await availablePoolLuna(tournamentId, deps);
        return toResult(sent, availableLuna);
      }
    }

    // Pre-flight BEFORE any new intent is written: a read-only RPC endpoint
    // can never broadcast, and discovering that after the WAL row exists
    // would strand a 'dispatching' withdrawal that recovery then re-fails
    // forever. (Existing intents were settled above; this protects only the
    // fresh path.)
    if (signer.canSign && !(await signer.canSign())) {
      throw new WithdrawError(
        "no-signer",
        "This deployment's payout endpoint can't sign transactions — withdrawals need a payout node holding the treasury key",
        503,
      );
    }

    // Fresh withdrawal: validate the amount.
    const { parseNim, formatNim } = await import("@/lib/nimiq/format");
    let amountLuna: bigint;
    try {
      amountLuna = parseNim(amountNim ?? "");
    } catch {
      throw new WithdrawError("bad-amount", "Enter a NIM amount with at most 5 decimals, like \"25\" or \"2.5\"");
    }
    if (amountLuna <= 0n) {
      throw new WithdrawError("bad-amount", "The withdrawal must be more than zero");
    }

    // A paid tournament with a preset but NO cut purse must not be drained
    // before the winners are even planned — cut the purse first. (Only
    // reachable on a live event whose operator pre-cut nothing; an ended
    // one is refused outright above.)
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

    // THE CAP: only uncommitted funds may leave.
    const { poolLuna, committedLuna, availableLuna } = await availablePoolLuna(tournamentId, deps);
    if (amountLuna > availableLuna) {
      throw new WithdrawError(
        "insufficient-available",
        `Only ${formatNim(availableLuna)} NIM of the ${formatNim(poolLuna)} NIM pool is uncommitted — ${formatNim(committedLuna)} NIM is locked by prizes, refunds and withdrawals`,
        409,
      );
    }

    // WRITE-AHEAD before any broadcast.
    const vsh = await currentHeight(deps, signer);
    const row: WithdrawRecord = {
      id: `withdraw_${now()}_${Math.random().toString(36).slice(2, 8)}`,
      tournamentId,
      amountLuna: amountLuna.toString(),
      recipientAddress: recipient,
      network: NIMIQ_NETWORK,
      status: "dispatching",
      withdrawTxHash: null,
      senderAddress: signer.getSenderAddress?.() ?? (deps.getTreasuryAddress ?? getCanonicalTreasuryAddress)() ?? null,
      validityStartHeight: vsh,
      dispatchAttempts: 1,
      lastBroadcastAt: null,
      failureReason: null,
      requestedAt: now(),
      sentAt: null,
      verifiedAt: null,
    };
    await store.append(row);

    const sent = await broadcastAndFinalize(store, row, vsh, signer, now(), false);
    const after = await availablePoolLuna(tournamentId, deps);
    return toResult(sent, after.availableLuna);
  });
}

/* ------------------------------------------------------------------ */
/* Confirm — real on-chain verification                                */
/* ------------------------------------------------------------------ */

/**
 * Verify a sent withdrawal on-chain and flip it to 'verified' only when the
 * REAL transaction matches the record exactly: sender == configured
 * treasury, recipient == the recorded linked wallet, value == the exact
 * recorded amount, execution succeeded, network matches, confirmations ≥
 * required. Same inclusive boundary as prize verification.
 */
export async function confirmPoolWithdrawal(
  tournamentId: string,
  adminPlayerId: string,
  deps: WithdrawDeps = {},
): Promise<WithdrawRecord> {
  const store = deps.store ?? fastStoreWithdrawStore;
  const now = deps.now ?? Date.now;

  return withPayoutLock(`withdraw-confirm:${tournamentId}`, async () => {
    if (!(await adminGate(deps, adminPlayerId))) {
      throw new WithdrawError("not-admin", "Only ChainMate can confirm a withdrawal", 403);
    }

    const rows = await store.listByTournament(tournamentId);
    const row = rows[rows.length - 1];
    if (!row) throw new WithdrawError("no-withdrawal", "No withdrawal has been requested for this tournament", 404);
    if (row.status === "verified") return row;
    if (row.status !== "sent" || !row.withdrawTxHash) {
      throw new WithdrawError(
        "not-sent",
        "Only a sent withdrawal with a real transaction hash can be confirmed",
        409,
      );
    }

    const config = getNimiqPayoutConfig();
    const required = deps.confirmationsRequired ?? config?.confirmationsRequired ?? 10;

    const fetchTx =
      deps.getTransactionByHash ??
      (async (hash: string, overrides?: Record<string, unknown>) => {
        const { getTransactionByHash } = await import("@/lib/server/nimiq/rpc");
        return getTransactionByHash(hash, overrides as Parameters<typeof getTransactionByHash>[1]);
      });
    const heightOf =
      deps.getBlockNumber ??
      (async (overrides?: Record<string, unknown>) => {
        const { getBlockNumber } = await import("@/lib/server/nimiq/rpc");
        return getBlockNumber(overrides as Parameters<typeof getBlockNumber>[0]);
      });
    const overrides = {
      url: config?.url,
      basicAuth: config?.basicAuth,
      apiKey: config?.apiKey,
      timeoutMs: 10_000,
    };

    const { NimiqRpcError } = await import("@/lib/server/nimiq/rpc");
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
      tx = (await fetchTx(row.withdrawTxHash, overrides)) as typeof tx;
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new WithdrawError("rpc-unavailable", "Could not reach the node to verify the withdrawal transaction", 503);
      }
      throw err;
    }

    if (!tx || typeof tx !== "object" || !tx.hash) {
      throw new WithdrawError("malformed-response", "The withdrawal transaction is not visible on the node yet", 502);
    }

    // Sender: the treasury of record — env config when present, otherwise
    // the write-ahead row's recorded sender (never client data).
    const expectedSender = canonicalAddress(
      (deps.getTreasuryAddress ?? getCanonicalTreasuryAddress)() ?? row.senderAddress ?? "",
    );
    if (!expectedSender || canonicalAddress(String(tx.from ?? "")) !== expectedSender) {
      throw new WithdrawError("wrong-sender", "Withdrawal transaction sender does not match the configured treasury", 502);
    }
    if (canonicalAddress(String(tx.to ?? "")) !== canonicalAddress(row.recipientAddress)) {
      throw new WithdrawError("wrong-recipient", "Withdrawal transaction recipient does not match the withdrawal record", 502);
    }

    let onChainLuna: bigint;
    try {
      onChainLuna = BigInt(String(tx.value ?? ""));
    } catch {
      throw new WithdrawError("malformed-response", "Node returned a non-integer transaction value", 502);
    }
    if (onChainLuna !== BigInt(row.amountLuna)) {
      throw new WithdrawError("amount-mismatch", "Withdrawal transaction amount does not match the withdrawal record", 502);
    }

    if (typeof tx.executionResult !== "boolean") {
      throw new WithdrawError("malformed-response", "Node response has no executionResult, withdrawal outcome cannot be established", 502);
    }
    if (!tx.executionResult) {
      throw new WithdrawError("failed-execution", "Withdrawal transaction failed on-chain execution", 502);
    }

    const expectedId = nimiqNetworkId(row.network);
    if (typeof tx.networkId !== "number") {
      throw new WithdrawError("malformed-response", "Node response has no networkId, withdrawal network cannot be established", 502);
    }
    if (tx.networkId !== expectedId) {
      const name = networkIdToName(tx.networkId);
      throw new WithdrawError(
        "wrong-network",
        `Withdrawal transaction is on networkId ${tx.networkId}${name ? ` (${name})` : ""}, expected ${expectedId} (${row.network})`,
        502,
      );
    }

    if (typeof tx.blockNumber !== "number" || tx.blockNumber < 0) {
      throw new WithdrawError("reconciliation-required", "Withdrawal transaction is not yet included in a block, retry shortly", 409);
    }

    let height: number;
    try {
      height = await heightOf(overrides);
    } catch (err) {
      if (err instanceof NimiqRpcError) {
        throw new WithdrawError("rpc-unavailable", "Could not reach the node to read the chain height", 503);
      }
      throw err;
    }
    const confirmations = height - tx.blockNumber + 1;
    if (confirmations < required) {
      throw new WithdrawError(
        "reconciliation-required",
        `Withdrawal has ${Math.max(confirmations, 0)} confirmations, ${required} required`,
        409,
      );
    }

    const verified: WithdrawRecord = {
      ...row,
      status: "verified",
      verifiedAt: now(),
    };
    await store.replace(verified);
    return verified;
  });
}

/* ------------------------------------------------------------------ */
/* Internal helpers (shared with nothing — kept local on purpose)      */
/* ------------------------------------------------------------------ */

/** Same bound as prize dispatch: 120 validity-window batches × 60 blocks. */
const VSH_STALENESS_BLOCKS = 7_200;

function toResult(row: WithdrawRecord, availableLunaAfter: bigint): WithdrawResult {
  return {
    amountLuna: row.amountLuna,
    status: row.status,
    withdrawTxHash: row.withdrawTxHash,
    recipientAddress: row.recipientAddress,
    availableLunaAfter: availableLunaAfter.toString(),
  };
}

async function currentHeight(deps: WithdrawDeps, signer: TreasurySigner): Promise<number> {
  if (deps.getBlockNumber) return deps.getBlockNumber();
  if (signer.getChainHeight) return signer.getChainHeight();
  try {
    const { getBlockNumber } = await import("@/lib/server/nimiq/rpc");
    const config = getNimiqPayoutConfig();
    return await getBlockNumber({
      url: config?.url,
      basicAuth: config?.basicAuth,
      apiKey: config?.apiKey,
      timeoutMs: 10_000,
    });
  } catch (err) {
    throw new WithdrawError(
      "rpc-unavailable",
      `Could not reach the payout node to read the chain height: ${err instanceof Error ? err.message : String(err)}`,
      503,
    );
  }
}

/** Broadcast with the given (reused or fresh) vsh and persist the outcome. */
async function broadcastAndFinalize(
  store: WithdrawStore,
  row: WithdrawRecord,
  vsh: number,
  signer: TreasurySigner,
  nowMs: number,
  isRecovery: boolean,
): Promise<WithdrawRecord> {
  let txHash: string;
  try {
    txHash = await signer.sendPayout(row.recipientAddress, BigInt(row.amountLuna), vsh);
  } catch (err) {
    // Broadcast failed — the WAL row stays 'dispatching' (the intent stands
    // and recovery is deterministic). Surface the typed dispatch error.
    if (err instanceof Error && err.name === "PayoutDispatchError") throw err;
    throw new WithdrawError(
      "broadcast-failed",
      `Withdrawal broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  if (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new WithdrawError("malformed-response", "Signer returned no usable transaction hash", 502);
  }
  const sent: WithdrawRecord = {
    ...row,
    status: "sent",
    withdrawTxHash: txHash,
    sentAt: nowMs,
    lastBroadcastAt: nowMs,
    validityStartHeight: row.validityStartHeight ?? vsh,
    dispatchAttempts: isRecovery ? (row.dispatchAttempts ?? 0) + 1 : row.dispatchAttempts,
    failureReason: null,
  };
  await store.replace(sent);
  return sent;
}
