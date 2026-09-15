"use client";

/**
 * Nimiq Mini App SDK wrapper — Phase 1A foundation.
 *
 * Wraps the REAL @nimiq/mini-app-sdk 0.1.0 API and nothing else. The SDK's
 * provider methods (verified from its .d.ts) return union types where the
 * success value and an ErrorResponse share a channel:
 *
 *   listAccounts():            Promise<string[] | ErrorResponse>
 *   sign(message):             Promise<SignatureResult | ErrorResponse>
 *   sendBasicTransaction(tx):  Promise<string | ErrorResponse>
 *   sendBasicTransactionWithData(tx): Promise<string | ErrorResponse>
 *
 * This module normalizes those unions so callers deal in plain results and
 * typed errors. It invents no methods: anything beyond the four wallet calls
 * above is out of scope by design (requirement 3).
 */

import {
  init as sdkInit,
  type ErrorResponse,
  type SignatureResult,
} from "@nimiq/mini-app-sdk";

export type { ErrorResponse, SignatureResult } from "@nimiq/mini-app-sdk";

/** Normalized failure — what ErrorResponse and thrown Errors both become. */
export interface NimiqWalletError {
  kind: "timeout" | "user-rejected" | "provider" | "no-accounts" | "unknown";
  message: string;
}

/** Thrown by pickWalletAccount when the wallet reports no accounts. */
export class NimiqNoAccountsError extends Error {
  constructor() {
    super(
      "No Nimiq account is available in this wallet — create one in Nimiq Pay and try again.",
    );
    this.name = "NimiqNoAccountsError";
  }
}

/** Discriminated result — the shape every wrapper function returns. */
export type NimiqResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NimiqWalletError };

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ErrorResponse).error?.message === "string"
  );
}

/** Convert an SDK ErrorResponse or thrown Error into a NimiqWalletError. */
export function normalizeNimiqError(err: unknown): NimiqWalletError {
  if (isErrorResponse(err)) {
    const type = err.error.type ?? "";
    const message = err.error.message || "The Nimiq wallet rejected the request";
    const kind: NimiqWalletError["kind"] = /reject|denied|cancel/i.test(`${type} ${message}`)
      ? "user-rejected"
      : /timed?\s*out|timeout/i.test(`${type} ${message}`)
        ? "timeout"
        : "provider";
    return { kind, message };
  }
  const message = err instanceof Error ? err.message : String(err);
  const kind: NimiqWalletError["kind"] = /not injected|running inside/i.test(message)
    ? "provider"
    : "unknown";
  return { kind, message };
}

function toResult<T>(value: T | ErrorResponse): NimiqResult<T> {
  if (isErrorResponse(value)) return { ok: false, error: normalizeNimiqError(value) };
  return { ok: true, value };
}

/** Wrap an SDK call so thrown errors and ErrorResponses become one shape. */
async function guard<T>(fn: () => Promise<T | ErrorResponse>): Promise<NimiqResult<T>> {
  try {
    return toResult(await fn());
  } catch (err) {
    return { ok: false, error: normalizeNimiqError(err) };
  }
}

/**
 * Wait for the host to inject window.nimiq (init with timeout, per the SDK
 * README). Returns the raw provider for advanced use; most callers should use
 * the helpers below.
 */
export async function connectNimiq(
  timeoutMs = 10_000,
): Promise<NimiqResult<Awaited<ReturnType<typeof sdkInit>>>> {
  return guard(() => sdkInit({ timeout: timeoutMs }));
}

/** Ask the wallet for its accounts. */
export async function listNimiqAccounts(
  nimiq: Awaited<ReturnType<typeof sdkInit>>,
): Promise<NimiqResult<string[]>> {
  return guard(() => nimiq.listAccounts());
}

/**
 * Connect action, end to end: init the provider and call listAccounts().
 *
 * Returns the provider plus the account the user chose (first account — the
 * wallet's own ordering — the SDK exposes no explicit selection API), or a
 * typed error:
 *
 *   - provider      → init() failed (host injected nothing usable)
 *   - no-accounts   → provider is fine but holds zero accounts: a REAL state
 *                     the UI must show ("create an account in Nimiq Pay"),
 *                     not silently treat as a generic failure
 *   - user-rejected / timeout / provider — from listAccounts() itself
 *
 * `deps.init` is a test seam: production callers omit it and get the real
 * SDK init().
 */
export async function pickWalletAccount(
  timeoutMs = 10_000,
  deps: {
    init?: (options?: { timeout?: number }) => Promise<
      Awaited<ReturnType<typeof sdkInit>>
    >;
  } = {},
): Promise<
  NimiqResult<{ nimiq: Awaited<ReturnType<typeof sdkInit>>; account: string }>
> {
  const initFn = deps.init ?? sdkInit;
  const connected = await guard(() => initFn({ timeout: timeoutMs }));
  if (!connected.ok) {
    return { ok: false, error: connected.error };
  }
  const accounts = await guard(() => connected.value.listAccounts());
  if (!accounts.ok) {
    return { ok: false, error: accounts.error };
  }
  if (accounts.value.length === 0) {
    return {
      ok: false,
      error: {
        kind: "no-accounts",
        message: new NimiqNoAccountsError().message,
      },
    };
  }
  return { ok: true, value: { nimiq: connected.value, account: accounts.value[0] } };
}

/** Ask the wallet to sign a message (string or { message, isHex }). */
export async function signNimiqMessage(
  nimiq: Awaited<ReturnType<typeof sdkInit>>,
  message: string | { message: string; isHex?: boolean },
): Promise<NimiqResult<SignatureResult>> {
  return guard(() => nimiq.sign(message));
}

/** Sign + send a basic transaction. Value/fee are luna integers (bigint-safe). */
export async function sendNimiqBasicTransaction(
  nimiq: Awaited<ReturnType<typeof sdkInit>>,
  tx: { recipient: string; value: bigint; fee?: bigint },
): Promise<NimiqResult<string>> {
  return guard(() =>
    nimiq.sendBasicTransaction({
      recipient: tx.recipient,
      // The SDK's wire type is number; luna totals for entry fees fit far
      // below Number.MAX_SAFE_INTEGER, so Number() here is exact. Callers
      // still hand us bigint so no caller-side float math can creep in.
      value: Number(tx.value),
      ...(tx.fee !== undefined ? { fee: Number(tx.fee) } : {}),
    }),
  );
}

/** Sign + send a basic transaction carrying hex data. */
export async function sendNimiqBasicTransactionWithData(
  nimiq: Awaited<ReturnType<typeof sdkInit>>,
  tx: { recipient: string; value: bigint; data: string; fee?: bigint },
): Promise<NimiqResult<string>> {
  return guard(() =>
    nimiq.sendBasicTransactionWithData({
      recipient: tx.recipient,
      value: Number(tx.value),
      data: tx.data,
      ...(tx.fee !== undefined ? { fee: Number(tx.fee) } : {}),
    }),
  );
}
