// Server-only module — never import from client components.

/**
 * Nimiq transaction verification — Phase 1C.
 *
 * Verifies a REAL on-chain transaction through the configured Nimiq node
 * before anything may consume it. The on-chain transaction and the player's
 * server-side wallet binding (Phase 1B) are the ONLY authorities; nothing the
 * client sends — sender, recipient, amount, network, status, confirmations —
 * is trusted.
 *
 * EXACT CONFIRMATION CALCULATION
 * ------------------------------
 *   confirmations = currentBlockHeight − txBlockHeight + 1
 *
 * (A transaction in the newest block has 1 confirmation — the same convention
 * Nimiq's explorer uses. The boundary is INCLUSIVE: requiring N confirmations
 * accepts a transaction when `confirmations >= N`.)
 *
 * REPLAY PROTECTION
 * -----------------
 * The consumption row is persisted ONLY after every verification check has
 * passed, and the database's UNIQUE (network, tx_hash) constraint is the
 * final durable guard: a duplicate insert (two racers verifying the same
 * transaction) surfaces as a typed conflict error, never a double acceptance.
 */

import {
  getCanonicalTreasuryAddress,
  getServerNimiqRpcConfig,
  NIMIQ_NETWORK,
  nimiqNetworkId,
  networkIdToName,
  type NimiqNetworkName,
} from "@/lib/nimiq/config";
import { toLuna, type NimiqMoneyError } from "@/lib/nimiq/format";
import {
  NimiqRpcError,
  getAccountByAddress,
  getBlockNumber,
  getTransactionByHash,
  type NimiqRpcTransaction,
} from "@/lib/server/nimiq/rpc";
import { friendlyAddress } from "@/lib/nimiq/address";
import { decodeProofData } from "@/lib/nimiq/proof";
import { verifyPaymentProof } from "@/lib/server/nimiq/proof";

/**
 * The real node response carries fields beyond 1A's minimal interface
 * (the flattened executionResult, networkId, and a nullable block height
 * while pending). Declared structurally HERE rather than in 1A so Phase 1A
 * stays untouched. `executionResult` is the current RPC's authoritative
 * execution verdict (ExecutedTransaction.executionResult, flattened onto the
 * transaction object by the node).
 */
interface NimiqTxWithProof extends Omit<NimiqRpcTransaction, "blockNumber"> {
  blockNumber?: number | null;
  executionResult?: unknown;
  networkId?: number;
  /** The data payload a proof-carrying payment routes through. */
  data?: unknown;
  /** Account type from the node (0 = basic, 1 = vesting, 2 = htlc). */
  fromType?: unknown;
}
type GetTxByHash = (
  hash: string,
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
) => Promise<NimiqTxWithProof | null>;
type GetBlockHeight = (
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
) => Promise<number>;
import { getLinkedWallet } from "@/lib/server/nimiq/service";
import { canonicalAddress } from "@/lib/server/nimiq/verify";

/** Typed verification failure categories, mapped to HTTP statuses. */
export type NimiqTxErrorKind =
  | "invalid-hash"
  | "wallet-not-linked"
  | "rpc-unavailable"
  | "transaction-not-found"
  | "wrong-network"
  | "failed-transaction"
  | "wrong-sender"
  | "wrong-recipient"
  | "wrong-amount"
  | "insufficient-confirmations"
  | "already-consumed"
  | "malformed-rpc-response"
  | "configuration-error";

const STATUS_BY_KIND: Record<NimiqTxErrorKind, number> = {
  "invalid-hash": 400,
  "wallet-not-linked": 409,
  "rpc-unavailable": 503,
  "transaction-not-found": 404,
  "wrong-network": 400,
  "failed-transaction": 400,
  "wrong-sender": 400,
  "wrong-recipient": 400,
  "wrong-amount": 400,
  "insufficient-confirmations": 409,
  "already-consumed": 409,
  "malformed-rpc-response": 502,
  "configuration-error": 503,
};

export class NimiqTxError extends Error {
  readonly kind: NimiqTxErrorKind;
  readonly status: number;
  constructor(kind: NimiqTxErrorKind, message: string) {
    super(message);
    this.name = "NimiqTxError";
    this.kind = kind;
    this.status = STATUS_BY_KIND[kind];
  }
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** 64 lowercase hex chars — the Nimiq transaction hash shape. */
const TX_HASH_RE = /^[0-9a-f]{64}$/;

export function normalizeTxHash(txHash: string): string {
  const hash = txHash.trim().toLowerCase();
  if (!TX_HASH_RE.test(hash)) {
    throw new NimiqTxError("invalid-hash", "Transaction hash must be 64 hex characters");
  }
  return hash;
}

/** What the future caller (2B tournament service) defines; never the client. */
export interface VerificationObligation {
  /** The player whose LINKED wallet must be the sender. */
  playerId: string;
  /** Exact expected amount in luna (bigint — never a float). */
  expectedAmountLuna: bigint;
  /** Expected recipient; defaults to the configured treasury address. */
  expectedRecipient?: string;
  /** Expected network; defaults to the deployment's configured network. */
  network?: NimiqNetworkName;
  /** What the consumption row records; defaults to 'verification'. */
  kind?: "verification" | "tournament_entry";
  /** Reserved for Phase 2B; recorded on the consumption row when present. */
  tournamentId?: string;
}

/** The verified, consumed transaction (mirror of the persisted row). */
export interface VerifiedNimiqTransaction {
  id: number | null;
  network: NimiqNetworkName;
  txHash: string;
  playerId: string;
  kind: string;
  tournamentId: string | null;
  sender: string;
  recipient: string;
  amountLuna: string;
  blockNumber: number;
  confirmations: number;
  verifiedAt: number;
}

/** Minimal seam over the consumption store so tests can fake persistence. */
export interface NimiqTxStore {
  findByNetworkAndHash(network: string, txHash: string): Promise<VerifiedNimiqTransaction | null>;
  insertConsumed(tx: Omit<VerifiedNimiqTransaction, "id" | "verifiedAt">): Promise<number>;
  /**
   * Phase 2B: every consumption row recorded for one tournament (used to
   * compute the verified prize pool). Optional — existing seam impls and the
   * Phase 1C tests keep working unchanged.
   */
  listByTournament?(tournamentId: string): Promise<VerifiedNimiqTransaction[]>;
}

/* ------------------------------------------------------------------ */
/* Fast-store implementation of the seam (+ Supabase mirror)           */
/* ------------------------------------------------------------------ */

/**
 * B2 — the consumption map lives under its own key in the SAME project
 * storage abstraction as every other ChainMate store (KV when configured,
 * else the .data file store) — raw fs only for the one-time import of the
 * pre-B2 format below.
 *
 * The key is versioned (:v2): the legacy import runs exactly ONCE per
 * deployment (when the v2 key does not exist yet), after which the v2 map
 * is authoritative. This keeps the migration deterministic and idempotent.
 */
const STORE_KEY = "chainmate:nimiq:transactions:v2";

async function readTxMap(): Promise<Record<string, VerifiedNimiqTransaction>> {
  const { getGameStorage } = await import("@/lib/server/storage");
  const raw = await getGameStorage().get(STORE_KEY);
  if (raw !== null) {
    try {
      return JSON.parse(raw) as Record<string, VerifiedNimiqTransaction>;
    } catch {
      return {};
    }
  }
  // First v2 read ever: import the pre-B2 raw-file rows (if any) once.
  return await importLegacyTxMap();
}

async function writeTxMap(map: Record<string, VerifiedNimiqTransaction>): Promise<void> {
  const { getGameStorage } = await import("@/lib/server/storage");
  await getGameStorage().set(STORE_KEY, JSON.stringify(map));
}

/**
 * One-time import of consumption rows written by the pre-B2 raw-file store
 * (a namespaced key inside .data/games.json). Writes the result under the
 * v2 key — even when empty — so the import runs exactly once per deployment
 * and no consumption history (the replay guard!) is lost on upgrade.
 */
async function importLegacyTxMap(): Promise<Record<string, VerifiedNimiqTransaction>> {
  const { readFileSafe } = await import("@/lib/server/legacy-store");
  const raw = readFileSafe("games.json");
  let legacy: Record<string, VerifiedNimiqTransaction> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      legacy = (parsed["chainmate:nimiq:transactions"] ?? {}) as Record<
        string,
        VerifiedNimiqTransaction
      >;
    } catch {
      legacy = {};
    }
  }
  await writeTxMap(legacy); // v2 key now exists: import never runs again
  return legacy;
}

/** Process-wide lock so concurrent verifies cannot both pass replay checks. */
const consumptionLocks = new Map<string, Promise<unknown>>();

async function withConsumptionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = consumptionLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  consumptionLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Durable consumption record. The Supabase UNIQUE (network, tx_hash) is the
 * cross-instance final guard; the project fast store + in-process lock is the
 * single-instance fast path. Duplicate consumption ALWAYS resolves to a
 * typed already-consumed error — never a silent double accept.
 *
 * B2: the map persists through the SAME project storage abstraction as every
 * other ChainMate store (KV when configured, else the .data file store) —
 * not raw fs — and the durable mirror is AWAITED where correctness depends
 * on it (insertConsumed), so a cross-instance duplicate insert surfaces as
 * the typed conflict instead of racing ahead unguarded.
 */
export const fastStoreTxStore: NimiqTxStore = {
  async findByNetworkAndHash(network, txHash) {
    const map = await readTxMap();
    return map[`${network}:${txHash}`] ?? null;
  },
  async listByTournament(tournamentId) {
    const map = await readTxMap();
    return Object.values(map).filter((row) => row.tournamentId === tournamentId);
  },
  async insertConsumed(tx) {
    // GLOBAL serialization, deliberately NOT keyed per tx hash: the map is
    // ONE persisted JSON value, so two verifies carrying different hashes
    // racing here each read the map, add their own row, and write the whole
    // value back — the later write clobbers the earlier row. Observed as lost
    // consumption rows in the full-field paid-join stress test (4 of 8 seats
    // lost their payment record). One map-wide lock keeps every consumption
    // durable; throughput is irrelevant at money-commit frequency.
    return withConsumptionLock("global", async () => {
      const map = await readTxMap();
      const key = `${tx.network}:${tx.txHash}`;
      if (map[key]) {
        throw new NimiqTxError("already-consumed", "This transaction was already consumed");
      }
      const id = Date.now(); // monotonic-enough local id; Supabase bigserial is authoritative in prod
      const row: VerifiedNimiqTransaction = { ...tx, id, verifiedAt: Date.now() };
      // Await the durable mirror BEFORE exposing success: if the mirror
      // reports the row already exists (another instance consumed this tx
      // first), the unique violation becomes the typed conflict and the
      // local map is NOT polluted with a second owner.
      await mirrorConsumption(row);
      map[key] = row;
      await writeTxMap(map);
      return id;
    });
  },
};

async function mirrorConsumption(tx: VerifiedNimiqTransaction): Promise<void> {
  // Imported lazily: keeps the Supabase client out of test runs entirely.
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const { supabaseConfigured } = await import("@/lib/supabase/config");
  if (!supabaseConfigured()) return;
  const admin = getSupabaseAdmin();
  if (!admin) return;
  let error: { message: string } | null = null;
  try {
    ({ error } = await admin.from("nimiq_transactions").insert({
      network: tx.network,
      tx_hash: tx.txHash,
      player_id: tx.playerId,
      kind: tx.kind,
      tournament_id: tx.tournamentId,
      sender: tx.sender,
      recipient: tx.recipient,
      amount_luna: tx.amountLuna,
      block_number: tx.blockNumber,
      confirmations: tx.confirmations,
    }));
  } catch (err) {
    // A thrown transport error is a Supabase outage, not a replay: the fast
    // store still records the consumption and the next mirror attempt can
    // backfill. Only the UNIQUE conflict below is authoritative enough to
    // fail the consumption.
    console.error(`[nimiq-tx] durable mirror threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (error) {
    // Unique violation = another instance consumed it first: typed conflict.
    // B2: surfaced to the caller (insertConsumed awaits this mirror) instead
    // of being swallowed — the local map is not updated in that case.
    if (/duplicate key|unique constraint|already exists/i.test(error.message)) {
      throw new NimiqTxError("already-consumed", "This transaction was already consumed");
    }
    console.error(`[nimiq-tx] durable mirror failed: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export interface VerifyDeps {
  rpc?: {
    getTransactionByHash: GetTxByHash;
    getBlockNumber: GetBlockHeight;
    /** Account lookup seam (defaults to the real RPC). Optional for compat. */
    getAccountByAddress?: (address: string, o?: { timeoutMs?: number }) => Promise<unknown>;
  };
  store?: NimiqTxStore;
  /** Wallet lookup seam (defaults to the Phase 1B service). */
  getLinkedWallet?: typeof getLinkedWallet;
  now?: () => number;
}

/** Shape of a successfully verified (but not yet persisted) on-chain tx. */
export interface OnChainVerification {
  tx: NimiqTxWithProof;
  blockHeight: number;
  confirmations: number;
  network: NimiqNetworkName;
  sender: string;
  recipient: string;
  amountLuna: string;
}

/** Internal: run every check and return the on-chain facts. */
async function verifyOnChain(
  txHash: string,
  obligation: VerificationObligation,
  deps: VerifyDeps,
): Promise<OnChainVerification> {
  // H4 — the canonical server-side treasury authority. A server-side
  // NIMIQ_TREASURY_ADDRESS wins when set; otherwise the NEXT_PUBLIC value
  // (which Next also ships to the browser) is honoured so existing single-
  // variable deployments keep working. Payout dispatch independently pins
  // NIMIQ_PAYOUT_TREASURY_ADDRESS and fails closed when the two disagree —
  // so entries can never land in one treasury while prizes leave another.
  const configuredTreasury = getCanonicalTreasuryAddress();
  const expectedRecipient = canonicalAddress(
    obligation.expectedRecipient ?? configuredTreasury,
  );

  if (!expectedRecipient) {
    throw new NimiqTxError(
      "configuration-error",
      "NIMIQ_TREASURY_ADDRESS is not configured, cannot verify an incoming transaction",
    );
  }

  // M1 — fail closed: the expected network MUST be explicit, and the node's
  // own networkId field MUST be present, a known id, and matching. A response
  // without usable network identity can never be verified into money state.
  const expectedNetwork: NimiqNetworkName = obligation.network ?? NIMIQ_NETWORK;
  const expectedId = nimiqNetworkId(expectedNetwork);

  // 1. The player's LINKED wallet (Phase 1B) — not any client-supplied sender.
  const linked = await (deps.getLinkedWallet ?? getLinkedWallet)(obligation.playerId);
  if (!linked) {
    throw new NimiqTxError("wallet-not-linked", "No Nimiq wallet is linked to this account");
  }

  // 2. The real transaction from the configured node.
  const rpc = deps.rpc ?? {
    getTransactionByHash,
    getBlockNumber,
    getAccountByAddress: (address: string, o?: { timeoutMs?: number }) =>
      getAccountByAddress(address, o),
  };
  let tx: NimiqTxWithProof | null;
  try {
    tx = await rpc.getTransactionByHash(txHash, { timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof NimiqRpcError) {
      // Surface the actual reason (missing NIMIQ_RPC_URL, HTTP status,
      // timeout, DNS/transport failure) — a bare "could not be reached"
      // makes operator misconfiguration indistinguishable from node outages.
      throw new NimiqTxError(
        "rpc-unavailable",
        `The Nimiq node could not be reached to verify this transaction (${err.message})`,
      );
    }
    throw err;
  }
  if (!tx || typeof tx !== "object" || typeof tx.hash !== "string" || !tx.hash) {
    throw new NimiqTxError("transaction-not-found", "Transaction not found on the network");
  }

  // 3. M1 — network identity, checked BEFORE anything else about the tx so a
  // cross-network replay dies here. Fail closed: missing or unknown networkId
  // on the node response rejects the verification outright.
  if (typeof tx.networkId !== "number") {
    throw new NimiqTxError(
      "malformed-rpc-response",
      "Node response has no networkId, network cannot be established, refusing verification",
    );
  }
  const knownNetworkId = networkIdToName(tx.networkId);
  if (!knownNetworkId) {
    throw new NimiqTxError(
      "wrong-network",
      `Transaction networkId ${tx.networkId} is not a known Nimiq network`,
    );
  }
  if (tx.networkId !== expectedId) {
    throw new NimiqTxError(
      "wrong-network",
      `Transaction is on networkId ${tx.networkId} (${knownNetworkId}), expected ${expectedId} (${expectedNetwork})`,
    );
  }

  // 4. Inclusion + execution success. A pending tx has no block height.
  if (
    typeof tx.blockNumber !== "number" ||
    !Number.isFinite(tx.blockNumber) ||
    tx.blockNumber < 0
  ) {
    throw new NimiqTxError(
      "transaction-not-found",
      "Transaction exists but is not yet included in a block",
    );
  }
  // Execution verdict comes from the current RPC's explicit `executionResult`
  // field (the old flags-bit heuristic misread the protocol's SIGNALING flag).
  // Fail closed: a response without a boolean verdict can never verify.
  if (typeof tx.executionResult !== "boolean") {
    throw new NimiqTxError(
      "malformed-rpc-response",
      "Node response has no executionResult, execution outcome cannot be established, refusing verification",
    );
  }
  if (!tx.executionResult) {
    throw new NimiqTxError("failed-transaction", "Transaction execution failed on-chain");
  }

  // 4. Sender attribution — the fix for the recurring "sender does not match"
  //    rejections. Nimiq Pay's sendBasicTransaction has NO sender parameter:
  //    the wallet picks the paying account itself, and on testnet it routes
  //    payments through HTLC/vesting wrapper contracts (and even recurring
  //    transfer contracts), so the on-chain sender is frequently NOT the
  //    linked identity address — yet the payment is still the linked
  //    wallet's. Attribution is therefore established in tiers:
  //
  //    (a) PROOF OF SIGNER (preferred): the tx carries a signed payment
  //        intent (embedded in its data field) whose signature verifies and
  //        whose proven key IS the linked wallet's key. Only the linked key
  //        can produce it — done, whatever the sender field says.
  //    (b) DIRECT: the sender IS the linked address (classic basic wallet).
  //    (c) OWNED CONTRACT: the sender is a contract account created by the
  //        linked wallet (live RPC lookup; HTLC/vesting wrappers) — the
  //        original Nimiq-Pay accommodation.
  //    Anything else is rejected with both addresses named.
  const sender = canonicalAddress(String(tx.from ?? ""));
  const linkedCanonical = canonicalAddress(linked.address);
  let senderVerified = sender === linkedCanonical;
  let senderProofNote: string | null = null;

  if (!senderVerified) {
    // (a) Proof of signer: a signature by the linked wallet's key over the
    // exact intent (player, tournament, amount, recipient, network) — every
    // field reconstructed SERVER-SIDE from this obligation, nothing parsed
    // from client input except the key/signature themselves.
    const proof = decodeProofData(tx.data);
    if (proof) {
      const verdict = await verifyPaymentProof(proof, {
        playerId: obligation.playerId,
        tournamentId: obligation.tournamentId ?? "",
        expectedAmountLuna: obligation.expectedAmountLuna,
        expectedRecipient,
        network: expectedNetwork,
        linkedAddress: linkedCanonical,
      });
      if (verdict.ok) {
        senderVerified = true;
        senderProofNote = "payment proof signed by the linked wallet's key";
      } else if (verdict.reason === "key-not-linked-wallet") {
        // A cryptographically wrong proof is AUTHORITATIVE evidence this
        // payment does not belong to this player — fail with that reason
        // rather than the generic sender mismatch.
        throw new NimiqTxError("wrong-sender", `Payment rejected: ${verdict.message}.`);
      }
      // A malformed/invalid proof falls through to (b)/(c) and then the
      // plain wrong-sender rejection if those fail too.
    }
  }

  if (!senderVerified) {
    // (c) Owned-contract accommodation: if the paying account is a contract
    // whose creator IS the linked wallet, the payment is legitimately the
    // linked wallet's (only the creator's key can create such a contract or
    // reclaim it). Fail closed on any lookup error.
    const creator = await contractCreatorFor(sender, rpc.getAccountByAddress);
    if (creator !== null && canonicalAddress(creator) === linkedCanonical) {
      senderVerified = true;
      senderProofNote = "paid from a contract created by the linked wallet";
    }
  }

  if (!senderVerified) {
    const fromType = tx.fromType;
    const txType = typeof fromType === "number" ? fromType : null;
    const typeHint =
      txType !== null && txType !== 0
        ? " The paying account is a contract-type account, but not one created by your linked wallet."
        : "";
    throw new NimiqTxError(
      "wrong-sender",
      `Transaction sender ${friendlyAddress(sender)} does not match your linked wallet ${friendlyAddress(linked.address)}.${typeHint} In Nimiq Pay, switch to the exact account you linked to ChainMate and pay from it.`,
    );
  }
  void senderProofNote; // kept for structured logging by callers if needed

  // 5. Recipient must be exactly the treasury (canonical compare).
  const recipient = canonicalAddress(String(tx.to ?? ""));
  if (recipient !== expectedRecipient) {
    throw new NimiqTxError("wrong-recipient", "Transaction recipient is not the expected address");
  }

  // 6. Value must equal the obligation exactly — bigint luna, no floats.
  let amountLuna: string;
  try {
    amountLuna = toLuna(tx.value as bigint | number | string).toString();
  } catch (err) {
    const moneyError = err as NimiqMoneyError;
    throw new NimiqTxError(
      "malformed-rpc-response",
      `Node returned a non-integer value: ${moneyError?.message ?? "unknown"}`,
    );
  }
  if (amountLuna !== obligation.expectedAmountLuna.toString()) {
    throw new NimiqTxError("wrong-amount", "Transaction amount does not match the expected amount");
  }

  // 7. Confirmations, computed server-side from block heights. INCLUSIVE
  //    boundary: a tx in the newest block has 1 confirmation, so requiring N
  //    confirmations accepts confirmations >= N.
  const config = getServerNimiqRpcConfig();
  const required = config?.confirmationsRequired ?? 10;
  let currentHeight: number;
  try {
    currentHeight = await rpc.getBlockNumber({ timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof NimiqRpcError) {
      throw new NimiqTxError(
        "rpc-unavailable",
        `Could not read the current chain height (${err.message})`,
      );
    }
    throw err;
  }
  if (typeof currentHeight !== "number" || !Number.isFinite(currentHeight)) {
    throw new NimiqTxError("malformed-rpc-response", "Node returned an invalid block height");
  }
  const confirmations = currentHeight - tx.blockNumber + 1;
  if (confirmations < required) {
    throw new NimiqTxError(
      "insufficient-confirmations",
      `Transaction has ${Math.max(confirmations, 0)} confirmations, ${required} required`,
    );
  }

  return {
    tx,
    blockHeight: tx.blockNumber,
    confirmations,
    network: expectedNetwork,
    sender,
    recipient,
    amountLuna,
  };
}

/**
 * Verify an incoming transaction end-to-end and record its consumption.
 *
 * Order is load-bearing: consumption is persisted ONLY after every check in
 * verifyOnChain() has passed, so a failed verification leaves no trace and
 * the transaction can be re-verified later (e.g. after more confirmations).
 */
/**
 * If `account` is a contract account created by a user wallet (HTLC or
 * vesting), return its creator address; anything else returns null.
 * Fail closed: any lookup error (missing RPC config, node down, malformed
 * body) returns null, which routes to the plain wrong-sender rejection.
 */
async function contractCreatorFor(
  account: string,
  lookup?: NonNullable<VerifyDeps["rpc"]>["getAccountByAddress"],
): Promise<string | null> {
  if (!lookup) return null;
  try {
    const raw = await lookup(account, { timeoutMs: 10_000 });
    if (!raw || typeof raw !== "object") return null;
    const acct = raw as {
      type?: number | string;
      sender?: unknown;
      owner?: unknown;
    };
    const type = typeof acct.type === "number" ? acct.type : String(acct.type ?? "").toLowerCase();
    const isContract =
      type === 2 || type === 3 || type === "htlc" || type === "vesting";
    if (!isContract) return null;
    const creator = acct.sender ?? acct.owner;
    return typeof creator === "string" && creator ? creator : null;
  } catch {
    return null;
  }
}

export async function verifyIncomingTransaction(
  txHashInput: string,
  obligation: VerificationObligation,
  deps: VerifyDeps = {},
): Promise<VerifiedNimiqTransaction> {
  const txHash = normalizeTxHash(txHashInput);

  // Replay check first (fast, typed) — but the durable guard is the insert.
  const store = deps.store ?? fastStoreTxStore;
  const network = obligation.network ?? NIMIQ_NETWORK;
  const existing = await store.findByNetworkAndHash(network, txHash);
  if (existing) {
    throw new NimiqTxError("already-consumed", "This transaction was already consumed");
  }

  const verified = await verifyOnChain(txHash, obligation, deps);

  const inserted = await store.insertConsumed({
    network: verified.network,
    txHash,
    playerId: obligation.playerId,
    kind: obligation.kind ?? "verification",
    tournamentId: obligation.tournamentId ?? null,
    sender: verified.sender,
    recipient: verified.recipient,
    amountLuna: verified.amountLuna,
    blockNumber: verified.blockHeight,
    confirmations: verified.confirmations,
  });

  return {
    id: inserted,
    network: verified.network,
    txHash,
    playerId: obligation.playerId,
    kind: obligation.kind ?? "verification",
    tournamentId: obligation.tournamentId ?? null,
    sender: verified.sender,
    recipient: verified.recipient,
    amountLuna: verified.amountLuna,
    blockNumber: verified.blockHeight,
    confirmations: verified.confirmations,
    verifiedAt: Date.now(),
  };
}
