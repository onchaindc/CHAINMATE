"use client";

/**
 * Paid tournament entry hook — ChainMate Phase 2B.
 *
 * Drives the REAL NIM payment flow on top of the Phase 1A wallet wrapper
 * and the Phase 1B linked-wallet hook:
 *
 *   1. require a linked wallet (Phase 1B)
 *   2. connect the provider (Phase 1A) and send a REAL basic transaction:
 *      recipient = treasury, value = the tournament's exact fee in luna
 *   3. capture the returned tx hash
 *   4. submit it to the server, which verifies the real transaction through
 *      Phase 1C and marks the entry paid
 *
 * Phases: idle → awaiting-wallet → submitting → verifying → joined | error.
 * Duplicate clicks are prevented via a busy flag that spans the whole flow.
 * The client never invents amounts or recipients — both come from the
 * tournament summary the server serves.
 *
 * CONFIRMATION-WINDOW HANDLING (the "2 confirmations, 10 required" case):
 * a payment the WALLET accepted is on-chain immediately, but the server
 * credits the entry only after N confirmations. Verification right after
 * broadcast therefore fails transiently. The hook polls the SAME tx hash
 * until it clears (server-side verification is idempotent — a resubmission
 * after consumption resolves to a typed already-consumed outcome that the
 * entry service treats as success) and surfaces live progress instead of a
 * dead-end error. No path here ever sends a SECOND payment: the pending
 * hash is kept and only ever re-verified.
 */

import { useCallback, useRef, useState } from "react";

import {
  connectNimiq,
  nimiqPaymentFailureMessage,
  sendNimiqBasicTransaction,
  waitForNimiqConsensus,
} from "@/lib/nimiq/miniapp";
import { parseNim } from "@/lib/nimiq/format";
import {
  VERIFY_MAX_ATTEMPTS,
  VERIFY_RETRY_INTERVAL_MS,
  confirmationsPending,
  isRetryableVerificationError,
  verificationProgressMessage,
} from "@/lib/nimiq/verify-retry";
import { useNimiqWallet } from "@/hooks/use-nimiq-wallet";
import { tournamentApi } from "@/lib/tournament-api";

export type EntryPhase =
  | "idle"
  | "awaiting-wallet"
  | "submitting"
  | "verifying"
  | "joined"
  | "error";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useTournamentEntry(playerId: string) {
  const wallet = useNimiqWallet(playerId);
  const [phase, setPhase] = useState<EntryPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  /** The on-chain payment awaiting enough confirmations — never re-paid. */
  const [pendingTxHash, setPendingTxHash] = useState<string | null>(null);
  /** Latest in-flight attempt, so a stale poll loop cannot clobber a new one. */
  const attemptRef = useRef(0);

  /**
   * Submit one verification attempt for `txHash`. Resolves true when the
   * entry is confirmed (or the server reports it already consumed BY US —
   * the idempotent path). Throws when verification says no.
   */
  const verifyOnce = useCallback(
    async (tournamentId: string, txHash: string): Promise<boolean> => {
      try {
        await tournamentApi.submitEntryTx(tournamentId, playerId, txHash);
        return true;
      } catch (err) {
        // The durable replay guard: this exact tx already paid for this
        // tournament. That IS success on the retry path — the seat exists.
        if (err instanceof Error && /already paid to join/i.test(err.message)) {
          return true;
        }
        throw err;
      }
    },
    [playerId],
  );

  /**
   * Poll verification for a tx that is on-chain but not yet credited.
   * Terminal failures stop immediately; transient ones (confirmations
   * accumulating, node hiccups) keep trying inside the window.
   */
  const pollVerification = useCallback(
    async (tournamentId: string, txHash: string): Promise<boolean> => {
      const attempt = ++attemptRef.current;
      setPhase("verifying");
      setError(null);
      for (let i = 1; i <= VERIFY_MAX_ATTEMPTS; i++) {
        if (attemptRef.current !== attempt) return false; // superseded
        try {
          const done = await verifyOnce(tournamentId, txHash);
          if (done) {
            setPendingTxHash(null);
            setProgress(null);
            setPhase("joined");
            return true;
          }
        } catch (err) {
          if (attemptRef.current !== attempt) return false;
          if (!isRetryableVerificationError(err)) {
            setProgress(null);
            setError(
              err instanceof Error
                ? nimiqPaymentFailureMessage(err)
                : "Payment verification failed.",
            );
            setPhase("error");
            return false;
          }
          const pending =
            err instanceof Error ? confirmationsPending(err.message) : null;
          setProgress(
            pending
              ? verificationProgressMessage(pending)
              : "The Nimiq node is slow to respond — still trying your payment…",
          );
        }
        if (i < VERIFY_MAX_ATTEMPTS) await sleep(VERIFY_RETRY_INTERVAL_MS);
      }
      // Window exhausted WITHOUT a terminal verdict: the payment is still
      // just waiting for confirmations. Keep the hash and let the player
      // re-verify (or the page reload pick it up) — never ask for money again.
      if (attemptRef.current === attempt) {
        setProgress(null);
        setError(
          "Your payment is on-chain but needs more confirmations to be credited. Press “Verify payment” in a moment — you will NOT be charged again.",
        );
        setPhase("error");
      }
      return false;
    },
    [verifyOnce],
  );

  /**
   * Pay the entry fee and join. `entryFeeNim` is the DISPLAY string from the
   * tournament summary — parsed to exact luna here only to populate the
   * wallet transaction; the server independently verifies the amount from
   * the tournament record, so a tampered client cannot underpay.
   */
  const payAndJoin = useCallback(
    async (
      tournamentId: string,
      entryFeeNim: string,
    ): Promise<{ outcome: "joined" | "pending" | "error"; txHash: string | null }> => {
      if (phase === "awaiting-wallet" || phase === "submitting" || phase === "verifying") {
        return { outcome: "error", txHash: null }; // duplicate-click guard
      }
      setError(null);
      setProgress(null);

      if (!wallet.wallet) {
        setError("Link your Nimiq wallet first.");
        setPhase("error");
        return { outcome: "error", txHash: null };
      }

      let feeLuna: bigint;
      try {
        feeLuna = parseNim(entryFeeNim);
      } catch {
        setError("This tournament's entry fee is invalid.");
        setPhase("error");
        return { outcome: "error", txHash: null };
      }

      setPhase("awaiting-wallet");
      try {
        const connected = await connectNimiq();
        if (!connected.ok) throw new Error(connected.error.message);

        // Real NIM transfer to the treasury. The RECIPIENT is the configured
        // treasury address from Phase 1A config — the same address the
        // server verifies against. Never a client-chosen address.
        const {
          NIMIQ_TREASURY_ADDRESS,
          isPlausibleNimiqAddress,
        } = await import("@/lib/nimiq/config");
        if (!NIMIQ_TREASURY_ADDRESS) {
          throw new Error("NIM treasury is not configured for this deployment.");
        }
        // A malformed recipient makes the WALLET itself fail with a cryptic
        // internal error far from the real cause. Validate the shape first
        // and say what is actually wrong: Nimiq addresses are exactly 36
        // characters.
        if (!isPlausibleNimiqAddress(NIMIQ_TREASURY_ADDRESS)) {
          throw new Error(
            `The configured NIM treasury address is invalid (${NIMIQ_TREASURY_ADDRESS.replace(/\s/g, "").length} characters — Nimiq addresses are 36, e.g. NQxx XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX). The deployment operator must correct the treasury configuration.`,
          );
        }
        // Best-effort sync/consensus pre-flight: Nimiq Pay cannot build a
        // transaction until its account sync finishes — the same failure the
        // wallet reports as "Something went wrong syncing your account".
        // The helper is fail-open (never blocks when unsupported), so this
        // only ever helps, never hurts.
        await waitForNimiqConsensus(connected.value);
        setPhase("submitting");
        const sent = await sendNimiqBasicTransaction(connected.value, {
          recipient: NIMIQ_TREASURY_ADDRESS,
          value: feeLuna,
        });
        if (!sent.ok) throw new Error(sent.error.message);
        const txHash = sent.value;

        // The money has MOVED. Whatever happens below, the hash is kept so
        // verification can be retried — never a second payment.
        setPendingTxHash(txHash);
        const confirmed = await pollVerification(tournamentId, txHash);
        return { outcome: confirmed ? "joined" : "pending", txHash };
      } catch (err) {
        // Normalize every failure into a human-readable message — the Nimiq
        // host adapter throws/resolves raw structured payloads, and the SDK's
        // own transport can build Error instances whose message is literally
        // "[object Object]". The original value is preserved on the console
        // for debugging and never swallowed.
        console.warn("[nimiq] payment flow failed:", err);
        setError(nimiqPaymentFailureMessage(err));
        setPhase("error");
        return { outcome: "error", txHash: null };
      }
    },
    [phase, playerId, wallet.wallet, pollVerification],
  );

  /**
   * Re-verify the pending payment (same hash — idempotent, never charges).
   * Also used as the recovery path after a page reload lost the hash but
   * the player still has it from their wallet history.
   */
  const reverify = useCallback(
    async (tournamentId: string, txHash?: string): Promise<boolean> => {
      const hash = (txHash ?? pendingTxHash)?.trim().toLowerCase();
      if (!hash) {
        setError("No pending payment to verify — pay first.");
        setPhase("error");
        return false;
      }
      return pollVerification(tournamentId, hash);
    },
    [pendingTxHash, pollVerification],
  );

  const reset = useCallback(() => {
    attemptRef.current += 1; // cancel any in-flight poll loop
    setPhase("idle");
    setError(null);
    setProgress(null);
    setPendingTxHash(null);
  }, []);
  return {
    wallet,
    phase,
    error,
    /** Live confirmation progress while verification is retrying. */
    progress,
    /** The on-chain tx awaiting enough confirmations, if any. */
    pendingTxHash,
    /** Adopt a stored hash (reload recovery) before re-verifying it. */
    setPendingTxHash,
    payAndJoin,
    reverify,
    reset,
    busy:
      phase === "awaiting-wallet" || phase === "submitting" || phase === "verifying",
  };
}
