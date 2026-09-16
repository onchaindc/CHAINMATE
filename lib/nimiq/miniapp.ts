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
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = (value as { error: unknown }).error;
  if (typeof inner === "object" && inner !== null) return true;
  // Some hosts/versions send the error payload as a bare string.
  return typeof inner === "string" && inner.length > 0;
}

/**
 * Human-readable text from an unknown value, without ever emitting the
 * useless "[object Object]". Error instances use their message; plain
 * objects are serialized to JSON (best-effort, with a hard cap so a huge
 * payload can never flood the UI); primitives use their string form.
 * Secrets never pass through here — inputs are wallet/provider error
 * payloads, and the cap plus JSON.stringify keep them textual.
 */
function describeUnknown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) {
    // An Error constructed around an object (the SDK's own RPC transport can
    // do `new Error(r.error.data || …)`) carries the useless literal text
    // "[object Object]" — recover what it actually means from `cause`, or
    // replace the string with something honest.
    if (value.message && value.message !== "[object Object]") return value.message;
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) {
      const causeText = describeUnknown(cause);
      if (causeText) return causeText;
    }
    if (value.message === "[object Object]") {
      return "The Nimiq wallet reported an unspecified error";
    }
    return value.message || value.name;
  }
  if (typeof value === "object") {
    // Error-like plain objects ({ message: "…" }) are a common host throw
    // shape — extract the field rather than serializing the wrapper.
    const messageField = (value as { message?: unknown }).message;
    if (typeof messageField === "string" && messageField.length > 0) {
      return messageField;
    }
    try {
      const json = JSON.stringify(value);
      if (typeof json === "string" && json.length > 0) {
        return json.length > 300 ? `${json.slice(0, 300)}…` : json;
      }
    } catch {
      /* circular or otherwise unserializable — fall through */
    }
    return null;
  }
  return null;
}

/**
 * Known wallet failures whose raw text is misleading or empty. Matched on
 * the combined type+message; when one matches, its real-cause text is used
 * instead. The original payload still reaches the console via guard().
 */
const KNOWN_ERROR_PATTERNS: Array<{
  match: RegExp;
  kind: NimiqWalletError["kind"];
  message: string;
}> = [
  {
    // Nimiq Pay fails the send when the wallet has not finished syncing the
    // account/chain ("Failed to send payment transaction: Something went
    // wrong syncing your account"). The raw string tells the user nothing
    // actionable — say what actually happened instead.
    match: /syncing your account/i,
    kind: "provider",
    message:
      "Nimiq Pay is still syncing your account. Open Nimiq Pay, wait for it to finish syncing (and check your connection), then try again.",
  },
];

/**
 * Convert an SDK ErrorResponse or thrown value into a NimiqWalletError.
 *
 * The SDK's host adapter does not guarantee an Error instance: Nimiq Pay
 * resolves ErrorResponse objects for some methods and THROWS raw structured
 * objects (and the SDK's own RPC transport does
 * `new Error(r.error.data || r.error.message)` — where `data` can itself be
 * an object, whose string form is exactly "[object Object]"). Every shape
 * must land in a readable message; the original is never swallowed.
 */
export function normalizeNimiqError(err: unknown): NimiqWalletError {
  // Shape 1: ErrorResponse — { error: { type, message } } (declared SDK type)
  //          or { error: "…" } (observed bare-string variant).
  if (isErrorResponse(err)) {
    const inner = (err as { error: unknown }).error;
    if (typeof inner === "object" && inner !== null) {
      const rec = inner as { type?: unknown; message?: unknown; data?: unknown };
      // Prefer a readable message; fall back through type, then data.
      const rawMessage = describeUnknown(rec.message) ?? describeUnknown(rec.data) ?? "";
      const type = typeof rec.type === "string" ? rec.type : describeUnknown(rec.type) ?? "";
      const combined = `${type} ${rawMessage}`;
      const known = KNOWN_ERROR_PATTERNS.find((p) => p.match.test(combined));
      if (known) return { kind: known.kind, message: known.message };
      const message = rawMessage || `The Nimiq wallet rejected the request${type ? ` (${type})` : ""}`;
      const kind: NimiqWalletError["kind"] = /reject|denied|cancel/i.test(combined)
        ? "user-rejected"
        : /timed?\s*out|timeout/i.test(combined)
          ? "timeout"
          : "provider";
      return { kind, message };
    }
    const message = `The Nimiq wallet rejected the request: ${inner as string}`;
    return /reject|denied|cancel/i.test(inner as string)
      ? { kind: "user-rejected", message }
      : { kind: "provider", message };
  }

  // Shape 2: anything thrown or resolved that is not an ErrorResponse —
  // Error instances, plain objects, strings, null/undefined.
  // An Error instance built around a structured payload (the SDK's own RPC
  // transport does `new Error(r.error.data || r.error.message)`, where data
  // can be an object) carries the real failure in `cause` — recurse into it
  // so the structured branch's extraction and classification apply.
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (
      (err.message === "[object Object]" || err.message === "") &&
      cause !== undefined &&
      cause !== err
    ) {
      return normalizeNimiqError(cause);
    }
  }
  const message = describeUnknown(err) ?? "The Nimiq wallet request failed";
  const known = KNOWN_ERROR_PATTERNS.find((p) => p.match.test(message));
  if (known) return { kind: known.kind, message: known.message };
  const kind: NimiqWalletError["kind"] = /not injected|running inside/i.test(message)
    ? "provider"
    : "unknown";
  return { kind, message };
}

/**
 * Human-readable message for any wallet/provider failure shape. This is what
 * UI surfaces render: never "[object Object]", never an empty string.
 */
export function nimiqErrorMessage(err: unknown): string {
  return normalizeNimiqError(err).message;
}

/**
 * User-facing message for a payment-flow failure: the same normalization,
 * with the "Nimiq payment failed:" prefix the entry UI shows. An
 * already-mangled "[object Object]" (the SDK's RPC transport builds
 * `new Error(structuredPayload)`, so the damage can exist before we see it)
 * is replaced with an honest description instead of being echoed.
 */
export function nimiqPaymentFailureMessage(err: unknown): string {
  if (err instanceof Error && err.message === "[object Object]") {
    return "Nimiq payment failed: the wallet reported an unspecified error. Try again — if it repeats, the wallet may not support this transaction.";
  }
  const message = nimiqErrorMessage(err);
  if (!message || message === "[object Object]") {
    return "Nimiq payment failed: the wallet reported an unspecified error.";
  }
  return /nimiq payment failed/i.test(message)
    ? message
    : `Nimiq payment failed: ${message}`;
}

function toResult<T>(value: T | ErrorResponse): NimiqResult<T> {
  if (isErrorResponse(value)) return { ok: false, error: normalizeNimiqError(value) };
  // A success channel value can still be an unusable stub (an empty object
  // or a null where a tx hash was expected). Fail loudly rather than handing
  // the caller a value it cannot use — "0" would be a falsy-but-real hash.
  if (value === null || value === undefined) {
    return {
      ok: false,
      error: normalizeNimiqError(value),
    };
  }
  return { ok: true, value };
}

/** Wrap an SDK call so thrown errors and ErrorResponses become one shape. */
async function guard<T>(fn: () => Promise<T | ErrorResponse>): Promise<NimiqResult<T>> {
  try {
    return toResult(await fn());
  } catch (err) {
    const error = normalizeNimiqError(err);
    // Keep the original throwable visible for debugging (requirement 5):
    // the normalized message is for humans, the raw value for the console.
    if (error.kind === "unknown" || error.kind === "provider") {
      console.warn("[nimiq] provider call failed:", err);
    }
    return { ok: false, error };
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

/**
 * Best-effort pre-flight for transaction sending: Nimiq Pay cannot build a
 * transaction before its chain/account sync has finished (message signing
 * needs no consensus — sending does, which is why binding works and paying
 * then fails with the wallet's opaque "syncing your account" error).
 *
 * IMPORTANT: `isConsensusEstablished` is NOT part of the SDK's
 * WALLET_METHODS set — on an in-app provider with no RPC URL configured it
 * throws "No RPC URL configured", so this check must never be load-bearing:
 * any failure or `false` result skips silently and the send is attempted
 * anyway (fail-open, matching the SDK's own opt-in design). It is a pure
 * bonus when the provider supports it.
 */
export async function waitForNimiqConsensus(
  nimiq: Awaited<ReturnType<typeof sdkInit>>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const method = (nimiq as { isConsensusEstablished?: () => Promise<boolean> })
    .isConsensusEstablished;
  if (typeof method !== "function") return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const established = await guard(async () => {
      const r = await method.call(nimiq);
      return typeof r === "boolean" ? r : true;
    });
    if (!established.ok) return true; // unsupported/broken: skip, don't block
    if (established.value) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true; // timed out: attempt the send anyway, let it fail with its real error
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
