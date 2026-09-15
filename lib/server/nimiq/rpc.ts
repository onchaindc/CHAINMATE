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
  params: unknown[];
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
}

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

/** Minimal JSON-RPC POST with timeout + optional Basic auth. */
async function rpcCall<T>(
  method: string,
  params: unknown[],
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
): Promise<T> {
  const config = getServerNimiqRpcConfig();
  const url = overrides?.url ?? config?.url;
  if (!url) {
    throw new NimiqRpcError(
      "NIMIQ_RPC_URL is not configured — there is no public Nimiq RPC default",
    );
  }
  const basicAuth = overrides?.basicAuth !== undefined ? overrides.basicAuth : config?.basicAuth;

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
    throw new NimiqRpcError(payload.error.message || "Nimiq RPC error", payload.error.code);
  }
  return payload.result as T;
}

/** Account lookup by NQ… address. Returns null when the node reports none. */
export async function getAccountByAddress(
  address: string,
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
): Promise<NimiqRpcAccount | null> {
  const account = await rpcCall<NimiqRpcAccount | null>(
    "getAccountByAddress",
    [address],
    overrides,
  );
  return account ?? null;
}

/** Transaction lookup by hash. Returns null while unknown to the node. */
export async function getTransactionByHash(
  hash: string,
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
): Promise<NimiqRpcTransaction | null> {
  const tx = await rpcCall<NimiqRpcTransaction | null>("getTransactionByHash", [hash], overrides);
  return tx ?? null;
}

/** Current chain height (blocks). */
export async function getBlockNumber(overrides?: {
  url?: string;
  basicAuth?: string | null;
  timeoutMs?: number;
}): Promise<number> {
  return rpcCall<number>("getBlockNumber", [], overrides);
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
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
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

export async function sendBasicTransaction(
  wallet: string,
  recipient: string,
  valueLuna: bigint,
  feeLuna: bigint,
  validityStartHeight: number,
  overrides?: { url?: string; basicAuth?: string | null; timeoutMs?: number },
): Promise<string> {
  if (valueLuna < 0n || feeLuna < 0n) {
    throw new NimiqRpcError("Transaction value and fee must be non-negative");
  }
  if (!Number.isSafeInteger(validityStartHeight) || validityStartHeight < 0) {
    throw new NimiqRpcError("validityStartHeight must be a non-negative safe integer");
  }
  const hash = await rpcCall<string>(
    "sendBasicTransaction",
    [wallet, recipient, valueLuna, feeLuna, validityStartHeight],
    overrides,
  );
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new NimiqRpcError("Node returned a malformed transaction hash");
  }
  return hash.toLowerCase();
}
