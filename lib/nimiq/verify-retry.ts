/**
 * Client-side retry policy for entry-payment verification.
 *
 * A Nimiq payment that the WALLET accepted is on-chain the moment
 * sendBasicTransaction returns a hash — but ChainMate's server deliberately
 * requires N confirmations before it credits an entry. Verification can
 * therefore legitimately fail right after a SUCCESSFUL payment, with
 *
 *   "Transaction has 2 confirmations, 10 required"
 *
 * That is a transient, retryable state, never a lost payment: re-submitting
 * the SAME tx hash is idempotent on the server (the durable replay guard
 * makes the second submission a typed already-consumed outcome, which the
 * entry flow treats as success). This module decides which failures deserve
 * another attempt and which are terminal — purely, so tests can pin the
 * policy without a network.
 *
 * Retryable:
 *  - confirmations still accumulating (parsed, drives progress copy)
 *  - transaction known but not yet in a block (broadcast still propagating)
 *  - node unavailable / timeouts / 5xx (the server could not ask the chain)
 *
 * Terminal (never retried — the message is already the answer):
 *  - wrong sender / recipient / amount, failed execution, wrong network
 *  - consumed by someone else, tournament full or closed, guest rejected
 */

import { TournamentApiError } from "@/lib/tournament-api";

/** Delay between verification attempts. Nimiq blocks are ~1s; this is lenient. */
export const VERIFY_RETRY_INTERVAL_MS = 4_000;

/** Total retry window. Two minutes covers slow testnet blocks with slack. */
export const VERIFY_MAX_WAIT_MS = 120_000;

/** Attempts = first try + retries inside the window. */
export const VERIFY_MAX_ATTEMPTS = Math.max(2, Math.ceil(VERIFY_MAX_WAIT_MS / VERIFY_RETRY_INTERVAL_MS));

/**
 * "Transaction has 2 confirmations, 10 required" → { have: 2, required: 10 }.
 * Returns null for any other message, so callers can tell progress apart
 * from failure text they must show verbatim.
 */
export function confirmationsPending(message: string): { have: number; required: number } | null {
  const m = /Transaction has (\d+) confirmations?, (\d+) required/.exec(message);
  if (!m) return null;
  const have = Number.parseInt(m[1] ?? "", 10);
  const required = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(have) || !Number.isFinite(required)) return null;
  return { have, required };
}

/** Node-side transient failures — the server could not establish the facts. */
const TRANSIENT_RPC_RE =
  /could not be reached|chain height|timed out|not yet included in a block|HTTP 5\d\d|request failed|network/i;

/**
 * Whether a verification failure is worth another attempt. Conservative by
 * design: an unrecognised failure is treated as terminal so a genuinely
 * broken payment surfaces immediately instead of spinning.
 */
export function isRetryableVerificationError(err: unknown): boolean {
  // The tournament service wraps every verification failure as
  // kind="verification-failed"; only the transient message shapes retry.
  if (err instanceof TournamentApiError) {
    if (err.kind === "already-paid") return false; // idempotent success, handled by the caller
    return confirmationsPending(err.message) !== null || TRANSIENT_RPC_RE.test(err.message);
  }
  if (err instanceof Error) {
    // Raw transport failures from fetch/next — always worth one more try.
    return TRANSIENT_RPC_RE.test(err.message) || /fetch|abort/i.test(err.message);
  }
  return false;
}

/** Friendly progress copy for a known confirmation count. */
export function verificationProgressMessage(p: { have: number; required: number }): string {
  if (p.required - p.have > 3) {
    return `Payment received — waiting for confirmations (${p.have}/${p.required}). Usually under a minute; you can leave this page and come back.`;
  }
  return `Almost there — ${p.have}/${p.required} confirmations…`;
}
