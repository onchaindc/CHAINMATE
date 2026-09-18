// Server-only module — never import from client components.

/**
 * Nimiq JSON-RPC client — Phase 1A foundation.
 *
 * A minimal, dependency-free JSON-RPC 2.0 client for a Nimiq node. The three
 * methods used here are the verified ones from the Nimiq RPC spec:
 *
 *   getAccountByAddress  [address]           → account object (balance in luna)
 *   getTransactionByHash [hash]              → transaction object | null
 *   getBlockNumber       []                  → number
 *
 * Deliberate properties (per the Phase 1A brief):
 *  - positional params only (Nimiq nodes use positional arrays, not named)
 *  - request timeout via AbortController
 *  - optional HTTP Basic auth (NIMIQ_RPC_BASIC_AUTH = "user:password")
 *  - NO public endpoint default: if NIMIQ_RPC_URL is unset, the client is
 *    unusable and says so — we never guess a node (requirement 9).
 */

import { getServerNimiqRpcConfig } from "@/lib/nimiq/config";

/** Default per-call timeout in milliseconds. */
const RPC_TIMEOUT_MS = 10_000;

/** Error thrown for every failure mode of the RPC client. */
export class NimiqRpcError extends Error {
  readonly code?: number | string;
  constructor(message: string, code?: number | string) {
    super(message);
    this.name = "NimiqRpcError";
    this.code = code;
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[] | object;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0" | string;
  id: number;
  result?: T;
  error?: { code: number | string; message: string; data?: unknown };
}

/** Raw shapes we rely on from the Nimiq node (subset, in luna). */
export interface NimiqRpcAccount {
  address: string;
  balance: number | string;
  type?: number | string;
  /** HTLC creator address (v2 field) — present on htlc accounts. */
  sender?: string;
  /** Vesting owner address (v2 field) — present on vesting accounts. */
  owner?: string;
  /** HTLC timeout, unix ms (v2 field) — after it the creator reclaims. */
  timeout?: number;
}

/**
 * A Nimiq v2 node accepts BOTH positional arrays and named objects for
 * dispatcher methods — verified live against a MainAlbatross node:
 *   getAccountByAddress ["NQxx …"]  → -32602 invalid type: string, expected
 *                                     struct ServiceArgs_…_get_account_by_address
 *   getAccountByAddress {address}   → 200 OK
 * The struct field name is the snake_case of the method's argument name
 * (address, max, offset…), so a named object with an `address` field is the
 * portable wire form. The legacy positional path is kept for nodes running
 * the older dispatcher.
 */
export type NimiqAccountParams =
  | { address: string }
  | [address: string];

export interface NimiqRpcTransaction {
  hash: string;
  from: string;
  to: string;
  value: number | string;
  fee?: number | string;
  blockNumber?: number;
  confirmations?: number;
  timestamp?: number;
}

/**
 * Per-call overrides. Security rule: `apiKey` is only inherited from the
 * configured endpoint when the caller uses that endpoint — a call that
 * overrides `url` (e.g. the dedicated payout node) never silently inherits
 * the read node's API key; it must pass its own explicitly.
 */
interface RpcOverrides {
  url?: string;
  basicAuth?: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
}

/** Minimal JSON-RPC POST with timeout + optional Basic auth. */
async function rpcCall<T>(
  method: string,
  params: unknown[] | object,
  overrides?: RpcOverrides,
): Promise<T> {
  const config = getServerNimiqRpcConfig();
  const url = overrides?.url ?? config?.url;
  if (!url) {
    throw new NimiqRpcError(
      "NIMIQ_RPC_URL is not configured, there is no public Nimiq RPC default",
    );
  }
  const basicAuth = overrides?.basicAuth !== undefined ? overrides.basicAuth : config?.basicAuth;
  // Key isolation: a custom URL never inherits the configured endpoint's key.
  const inheritedApiKey = overrides?.url !== undefined ? null : config?.apiKey;
  const apiKey = overrides?.apiKey !== undefined ? overrides.apiKey : inheritedApiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), overrides?.timeoutMs ?? RPC_TIMEOUT_MS);
  let payload: JsonRpcResponse<T>;
  let status = 0;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (basicAuth) {
      // Node's Buffer exists in the Edge-free Node runtime this app uses
      // (every route sets `export const runtime = "nodejs"`).
      headers.Authorization = `Basic ${Buffer.from(basicAuth).toString("base64")}`;
    }
    if (apiKey) {
      // Managed-node providers (e.g. Nownodes) authenticate with this header
      // instead of HTTP Basic auth.
      headers["api-key"] = apiKey;
    }
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: Date.now() % 1_000_000,
      method,
      params,
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    status = res.status;
    if (!res.ok) {
      throw new NimiqRpcError(`Nimiq RPC returned HTTP ${res.status}`);
    }
    // A node that answers 200 with a broken body surfaces through the same
    // catch below as a transport failure — there is no third path.
    payload = (await res.json()) as JsonRpcResponse<T>;
  } catch (err) {
    if (err instanceof NimiqRpcError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NimiqRpcError(`Nimiq RPC timed out after ${overrides?.timeoutMs ?? RPC_TIMEOUT_MS}ms`);
    }
    if (status >= 400) {
      throw new NimiqRpcError(`Nimiq RPC returned HTTP ${status}`);
    }
    throw new NimiqRpcError(
      `Nimiq RPC request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (payload.error) {
    // Nimiq v2 nodes report unknown transactions/accounts as JSON-RPC errors,
    // not null results (verified against the live testnet node:
    // {code:-32603, data:"Transaction not found: <hash>"}). Our callers
    // (getTransactionByHash / getAccountByAddress) define "not found" as
    // null, so translate those specific errors instead of failing the call.
    const errorData = typeof payload.error.data === "string" ? payload.error.data : "";
    if (payload.error.code === -32603 && /not found/i.test(errorData)) {
      return null as T;
    }
    throw new NimiqRpcError(payload.error.message || "Nimiq RPC error", payload.error.code);
  }

  // Nimiq v2 (Albatross) nodes wrap every successful result as
  // { data: T, metadata: … } — verified live: getBlockNumber returns
  // {"data":11604878,"metadata":null}. Unwrap transparently so callers see
  // the plain value. A v1-style bare result (or an already-unwrapped one)
  // passes through unchanged.
  const result = payload.result as unknown;
  if (
    result !== null &&
    typeof result === "object" &&
    "data" in result &&
    ("metadata" in result)
  ) {
    return (result as { data: unknown }).data as T;
  }
  return payload.result as T;
}

/** Account lookup by NQ… address. Returns null when the node reports none. */
export async function getAccountByAddress(
  address: string,
  overrides?: RpcOverrides,
): Promise<NimiqRpcAccount | null> {
  // Named-object params are the v2 struct form; the positional array is the
  // legacy form. The named form is preferred for v2 (struct-expecting)
  // dispatchers; a node that still wants positional keeps working because we
  // retry positional when the struct form is rejected with -32602.
  const named: NimiqAccountParams = { address };
  try {
    const account = await rpcCall<NimiqRpcAccount | null>(
      "getAccountByAddress",
      named,
      overrides,
    );
    return account ?? null;
  } catch (err) {
    // A -32602 (invalid params) on the named form: retry the positional
    // legacy wire form once, so an older node keeps working.
    if (err instanceof NimiqRpcError && String(err.code) === "-32602") {
      const account = await rpcCall<NimiqRpcAccount | null>(
        "getAccountByAddress",
        [address],
        overrides,
      );
      return account ?? null;
    }
    throw err;
  }
}

/**
 * Transactions touching an address (in or out), newest first. v2 struct
 * form: { address, max?, offset? } — verified live; a -32602 falls back to
 * the legacy positional array [address, max] for older dispatchers.
 */
export interface NimiqAddressTransaction extends NimiqRpcTransaction {
  fromType?: number | string;
  toType?: number | string;
}

export async function getTransactionsByAddress(
  address: string,
  max = 25,
  overrides?: RpcOverrides,
): Promise<NimiqAddressTransaction[]> {
  const named = { address, max };
  try {
    const txs = await rpcCall<NimiqAddressTransaction[] | null>(
      "getTransactionsByAddress",
      named,
      overrides,
    );
    return Array.isArray(txs) ? txs : [];
  } catch (err) {
    if (err instanceof NimiqRpcError && String(err.code) === "-32602") {
      const txs = await rpcCall<NimiqAddressTransaction[] | null>(
        "getTransactionsByAddress",
        [address, max],
        overrides,
      );
      return Array.isArray(txs) ? txs : [];
    }
    throw err;
  }
}

/** Transaction lookup by hash. Returns null while unknown to the node. */
export async function getTransactionByHash(
  hash: string,
  overrides?: RpcOverrides,
): Promise<NimiqRpcTransaction | null> {
  const tx = await rpcCall<NimiqRpcTransaction | null>("getTransactionByHash", [hash], overrides);
  return tx ?? null;
}

/** Current chain height (blocks). */
export async function getBlockNumber(overrides?: RpcOverrides): Promise<number> {
  return rpcCall<number>("getBlockNumber", [], overrides);
}

/* ------------------------------------------------------------------ */
/* Total-holdings read (basic + wallet-created wrapper contracts)       */
/* ------------------------------------------------------------------ */
/*
 * Nimiq Pay does not keep a user's balance only in the basic account: it
 * sweeps funds into HTLC/vesting wrapper contracts CREATED by the user's
 * address and pays from those wrappers (the wallet's transfers leave from
 * fromType=2 contract accounts). A balance check that reads only the basic
 * account therefore reports ZERO for a wallet whose visible balance is
 * actually large — the exact "my account has zero NIM" report from an
 * operator whose 2453 NIM sat in an HTLC wrapper their address created.
 *
 * True spendable-control = basic balance + the balance of every
 * active wrapper contract the address created:
 *   - HTLC (type 2 / "htlc"): creator = account.sender; funds are
 *     reclaimable by the creator once the timeout passes, and the wallet
 *     spends from the wrapper while it is live.
 *   - Vesting (type 1 / "vesting"): owner = account.owner.
 *
 * Only FUTURE-timeout contracts count: an expired HTLC has effectively
 * returned to the creator's basic account (or is reclaimable there), and
 * counting it too would double-count.
 */

/** Number of recent transactions scanned for wrapper-contract discovery. */
export const WRAPPER_SCAN_TX_COUNT = 50;

/**
 * Pure classification: does this raw account object represent a
 * wallet-created wrapper contract (HTLC or vesting)? Exported for tests.
 * `nowMs` is injectable so the timeout logic is deterministic.
 */
export function isOwnedWrapperContract(
  account: {
    type?: number | string;
    sender?: unknown;
    owner?: unknown;
    timeout?: unknown;
  },
  creatorAddress: string,
  nowMs: number,
): boolean {
  const type = typeof account.type === "number" ? account.type : String(account.type ?? "").toLowerCase();
  const isHtlc = type === 2 || type === "htlc";
  const isVesting = type === 1 || type === "vesting";
  if (!isHtlc && !isVesting) return false;

  const creator = account.sender ?? account.owner;
  if (typeof creator !== "string" || !creator) return false;
  if (creator.replace(/\s/g, "").toLowerCase() !== creatorAddress.replace(/\s/g, "").toLowerCase()) {
    return false;
  }

  // An HTLC whose timeout has passed no longer holds spendable wrapper
  // funds (the creator reclaims them into their basic account).
  if (isHtlc && typeof account.timeout === "number" && account.timeout <= nowMs) {
    return false;
  }
  return true;
}

/**
 * The wallet's TRUE controllable balance in luna: basic account plus every
 * active wrapper contract the address created (discovered from recent tx
 * history — a wrapper only matters if a transaction touched the address).
 * Never throws for individual counterparty lookups: a contract account that
 * fails to resolve contributes 0 rather than failing the whole read.
 */
export async function getTotalHoldingsLuna(
  address: string,
  overrides?: RpcOverrides,
): Promise<{ totalLuna: bigint; basicLuna: bigint; wrapperLuna: bigint; wrappers: number }> {
  const nowMs = Date.now();
  const canonical = address.replace(/\s/g, "");

  const basic = await getAccountByAddress(address, overrides);
  let basicLuna = 0n;
  if (basic) {
    basicLuna =
      typeof basic.balance === "string" ? BigInt(basic.balance) : BigInt(Math.trunc(Number(basic.balance)));
  }

  // Discover wrapper contracts from recent history: any contract-typed
  // counterparty is a candidate. Lookups are best-effort — one broken
  // account must not fail the whole balance read.
  const candidates = new Set<string>();
  let txs: NimiqAddressTransaction[] = [];
  try {
    txs = await getTransactionsByAddress(address, WRAPPER_SCAN_TX_COUNT, overrides);
  } catch {
    txs = [];
  }
  for (const tx of txs) {
    for (const [addr, type] of [
      [String(tx.from ?? ""), tx.fromType],
      [String(tx.to ?? ""), tx.toType],
    ] as const) {
      const a = addr.replace(/\s/g, "");
      if (!a || a === canonical) continue;
      if (type !== undefined && String(type) !== "0" && String(type) !== "basic") {
        candidates.add(a);
      }
    }
  }

  let wrapperLuna = 0n;
  let wrappers = 0;
  for (const candidate of candidates) {
    try {
      const acct = await getAccountByAddress(candidate, overrides);
      if (!acct) continue;
      if (!isOwnedWrapperContract(acct, canonical, nowMs)) continue;
      wrapperLuna +=
        typeof acct.balance === "string" ? BigInt(acct.balance) : BigInt(Math.trunc(Number(acct.balance)));
      wrappers += 1;
    } catch {
      // best-effort: an unresolvable contract contributes 0
    }
  }

  return { totalLuna: basicLuna + wrapperLuna, basicLuna, wrapperLuna, wrappers };
}

/* ------------------------------------------------------------------ */
/* Phase 3B — payout-node methods (wallet dispatcher)                   */
/* ------------------------------------------------------------------ */
/*
 * These two additions speak to the WALLET dispatcher of a Nimiq node that
 * holds the treasury hot key in its keystore (the Phase 3A architecture).
 * They are additive: every Phase 1A/1C caller keeps working unchanged.
 */

/** Whether the node's keystore has the given wallet unlocked right now. */
export async function isAccountUnlocked(
  address: string,
  overrides?: RpcOverrides,
): Promise<boolean> {
  return rpcCall<boolean>("isAccountUnlocked", [address], overrides);
}

/**
 * Sign + broadcast a basic transaction from the node's keystore wallet.
 *
 * Wire contract (verified against core-rs-albatross consensus dispatcher +
 * nimiq.dev RPC reference):
 *   params: [wallet, recipient, value(luna, integer), fee(luna),
 *            validityStartHeight (number, or "+N" relative string)]
 *   result: the transaction hash (Blake2b, hex string)
 *
 * `validityStartHeight` is caller-controlled ON PURPOSE: recording it before
 * broadcast makes a crash-recovery re-broadcast byte-identical (same hash),
 * which is the entire crash-safety story. Nimiq transactions are fully
 * deterministic functions of their fields (TransactionBuilder::new_basic is
 * pure and ed25519 signing is deterministic per RFC 8032).
 */
export interface SendBasicTransactionResult {
  hash: string;
}

/**
 * The node's Coin type accepts JSON numbers up to 2^53 − 1 (its deserializer
 * rejects anything ≥ 2^53), and JSON itself cannot carry bigint values —
 * JSON.stringify throws "Do not know how to serialize a BigInt". Convert an
 * exact luna bigint to a Number at the wire boundary ONLY, after proving the
 * conversion is lossless. Anything outside the safe range is rejected here,
 * before any HTTP request is made.
 */
function lunaToWire(luna: bigint, name: string): number {
  if (luna < 0n) {
    throw new NimiqRpcError(`${name} must be non-negative`);
  }
  if (luna > Number.MAX_SAFE_INTEGER) {
    throw new NimiqRpcError(
      `${name} ${luna} exceeds the JSON-safe integer range (2^53 - 1 luna) — refusing a lossy conversion`,
    );
  }
  return Number(luna);
}

export async function sendBasicTransaction(
  wallet: string,
  recipient: string,
  valueLuna: bigint,
  feeLuna: bigint,
  validityStartHeight: number,
  overrides?: RpcOverrides,
): Promise<string> {
  // Value and fee cross as JSON numbers (the node's Coin wire type) — the
  // bigint API stays at this function's boundary, serialization is exact.
  const value = lunaToWire(valueLuna, "Transaction value");
  const fee = lunaToWire(feeLuna, "Transaction fee");
  if (!Number.isSafeInteger(validityStartHeight) || validityStartHeight < 0) {
    throw new NimiqRpcError("validityStartHeight must be a non-negative safe integer");
  }
  const hash = await rpcCall<string>(
    "sendBasicTransaction",
    [wallet, recipient, value, fee, validityStartHeight],
    overrides,
  );
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new NimiqRpcError("Node returned a malformed transaction hash");
  }
  return hash.toLowerCase();
}
