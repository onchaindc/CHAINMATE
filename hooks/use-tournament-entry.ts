"use client";

/**
 * Paid tournament entry hook — ChainMate Phase 2B.
 *
 * Drives the REAL NIM payment flow on top of the Phase 1A wallet wrapper
 * and the Phase 1B linked-wallet hook:
 *
 *   1. require a linked wallet (Phase 1B)
 *   2. sign a PAYMENT-INTENT PROOF with the wallet (no cost — a message
 *      signature that cryptographically binds this payment to the linked
 *      wallet's key, player, tournament, exact amount, treasury, network)
 *   3. send the real transaction to the treasury carrying the proof in its
 *      data field when the wallet supports it (sendBasicTransaction has NO
 *      sender parameter — Nimiq Pay picks the paying account itself, so the
 *      proof is what attributes the payment; see lib/nimiq/proof.ts). Wallets
 *      whose wrapper-account machinery cannot carry a data field reject the
 *      send with "Transaction invalidated during transaction" and move
 *      nothing — the send helper then automatically retries as a PLAIN
 *      transfer, and the server attributes that payment through the legacy
 *      direct/owned-contract sender rules (verifyOnChain tiers b/c).
 *   4. submit the tx hash to the server, which verifies the real on-chain
 *      transaction (proof → or legacy direct/owned-contract sender rules)
 *      through Phase 1C and marks the entry paid
 *
 * ANTI-DOUBLE-PAY (the "endless paying loop" fix): from the moment
 * sendBasicTransaction returns a hash, that hash is THE payment for this
 * flow. The Pay button never reappears while a sent payment is uncredited —
 * only "Verify payment" does, which re-checks the SAME hash and can never
 * move money. A second payment can only be sent after the player explicitly
 * dismisses an uncredited one (terminal verification failure), and the
 * server independently refuses a second paid seat.
 *
 * Phases: idle → awaiting-wallet → submitting → verifying → joined | error.
 */

import { useCallback, useRef, useState } from "react";

import {
  connectNimiq,
  listNimiqAccounts,
  nimiqPaymentFailureMessage,
  sendNimiqBasicTransaction,
  signNimiqPaymentProof,
  waitForNimiqConsensus,
} from "@/lib/nimiq/miniapp";
import { encodeProofDataHex, proofMessage } from "@/lib/nimiq/proof";
import { canonicalAddress } from "@/lib/nimiq/address";
import { parseNim } from "@/lib/nimiq/format";
import {
  VERIFY_MAX_ATTEMPTS,
  VERIFY_RETRY_INTERVAL_MS,
  confirmationsPending,
  isRetryableVerificationError,
  verificationProgressMessage,
} from "@/lib/nimiq/verify-retry";
import {
  clearPendingEntryTx,
  loadPendingEntryTx,
  savePendingEntryTx,
} from "@/lib/nimiq/pending-entry-tx";
import { shortNimiqAddress, useNimiqWallet } from "@/hooks/use-nimiq-wallet";
import { TournamentApiError, tournamentApi } from "@/lib/tournament-api";

export type EntryPhase =
  | "idle"
  | "awaiting-wallet"
  | "submitting"
  | "verifying"
  | "joined"
  | "error";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A second payment arrived while the seat was already paid by another tx. */
export class AlreadyPaidError extends Error {
  constructor() {
    super(
      "You have already paid for this tournament — this extra payment cannot be attached to another seat. Nothing was charged twice for one entry; the extra transfer stays on-chain to the treasury.",
    );
    this.name = "AlreadyPaidError";
  }
}

export function useTournamentEntry(playerId: string) {
  const wallet = useNimiqWallet(playerId);
  const [phase, setPhase] = useState<EntryPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  /** The on-chain payment awaiting enough confirmations — never re-paid. */
  const [pendingTxHash, setPendingTxHashState] = useState<string | null>(null);
  /** Latest in-flight attempt, so a stale poll loop cannot clobber a new one. */
  const attemptRef = useRef(0);

  const setPendingTxHash = useCallback((hash: string | null) => {
    setPendingTxHashState(hash);
  }, []);

  /**
   * Submit one verification attempt for `txHash`. Throws on failure —
   * including AlreadyPaidError when the server says the seat was paid by a
   * DIFFERENT transaction (that is never treated as success: the extra
   * payment must be surfaced, not swallowed).
   */
  const verifyOnce = useCallback(
    async (tournamentId: string, txHash: string): Promise<void> => {
      try {
        await tournamentApi.submitEntryTx(tournamentId, playerId, txHash);
      } catch (err) {
        if (err instanceof TournamentApiError && err.kind === "already-paid") {
          throw new AlreadyPaidError();
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
          await verifyOnce(tournamentId, txHash);
          setPendingTxHash(null);
          clearPendingEntryTx(tournamentId, playerId);
          setProgress(null);
          setPhase("joined");
          return true;
        } catch (err) {
          if (attemptRef.current !== attempt) return false;
          if (err instanceof AlreadyPaidError || !isRetryableVerificationError(err)) {
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
      // ANTI-DOUBLE-PAY: a sent-but-uncredited payment exists — re-verifying
      // it is the only correct action; paying again would burn funds. The
      // durable store is checked too, so a reload that dropped the in-memory
      // hash still cannot reach a second send.
      const storedHash = loadPendingEntryTx(tournamentId, playerId);
      if (pendingTxHash || storedHash) {
        if (storedHash && !pendingTxHash) setPendingTxHash(storedHash);
        setError(
          "A payment is already on-chain for this tournament and hasn't been credited yet. Verify it below — you will NOT be charged again by verifying.",
        );
        setPhase("error");
        return { outcome: "error", txHash: null };
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
        if (feeLuna <= 0n) throw new Error("fee must be positive");
      } catch {
        setError("This tournament's entry fee is invalid.");
        setPhase("error");
        return { outcome: "error", txHash: null };
      }

      setPhase("awaiting-wallet");
      try {
        const { NIMIQ_TREASURY_ADDRESS, NIMIQ_NETWORK, isPlausibleNimiqAddress } =
          await import("@/lib/nimiq/config");
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
        const treasury = canonicalAddress(NIMIQ_TREASURY_ADDRESS);

        const connected = await connectNimiq();
        if (!connected.ok) throw new Error(connected.error.message);

        // Best-effort sync/consensus pre-flight: Nimiq Pay cannot build a
        // transaction until its account sync finishes — the same failure the
        // wallet reports as "Something went wrong syncing your account".
        // Fail-open: this only ever helps, never blocks.
        await waitForNimiqConsensus(connected.value);

        // PRE-SEND ACCOUNT CHECK: if the wallet's active account is NOT the
        // linked one, stop BEFORE any money moves. sendBasicTransaction has
        // no sender parameter — the wallet pays from whatever account is
        // active — so this is the only moment a mismatch can be caught for
        // free. Fail-open only when the account list itself is unavailable.
        const accounts = await listNimiqAccounts(connected.value);
        if (accounts.ok) {
          const linkedCanonical = canonicalAddress(wallet.wallet.address);
          const activeHasLinked = accounts.value.some(
            (a) => canonicalAddress(a) === linkedCanonical,
          );
          if (!activeHasLinked) {
            throw new Error(
              `Your Nimiq Pay wallet is currently on a different account. Switch to the account linked to ChainMate (${shortNimiqAddress(wallet.wallet.address)}) before paying — payments from any other account cannot be credited.`,
            );
          }
        }

        // PROOF OF SIGNER — signed BEFORE any money moves, so the wallet's
        // key authorizes exactly this payment (player, tournament, amount,
        // treasury, network). No cost; the user confirms a signature sheet.
        const intentMessage = proofMessage({
          playerId,
          tournamentId,
          amountLuna: feeLuna.toString(),
          recipient: treasury,
          network: NIMIQ_NETWORK,
        });
        const proof = await signNimiqPaymentProof(connected.value, intentMessage);
        if (!proof.ok) throw new Error(proof.error.message);

        setPhase("submitting");
        const sent = await sendNimiqBasicTransaction(connected.value, {
          recipient: treasury,
          value: feeLuna,
          data: encodeProofDataHex({
            publicKey: proof.value.publicKey,
            signature: proof.value.signature,
          }),
        });
        if (!sent.ok) throw new Error(sent.error.message);
        const txHash = sent.value;

        // The money has MOVED. Whatever happens below, the hash is kept so
        // verification can be retried — never a second payment. Persisted
        // IMMEDIATELY: a reload mid-confirmation-window must still find it
        // (the old code saved only after the whole poll finished, which is
        // exactly how payments got orphaned).
        setPendingTxHash(txHash);
        savePendingEntryTx(tournamentId, playerId, txHash);
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
    [phase, playerId, wallet.wallet, pendingTxHash, pollVerification],
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
      setPendingTxHash(hash);
      return pollVerification(tournamentId, hash);
    },
    [pendingTxHash, pollVerification, setPendingTxHash],
  );

  /**
   * Give up on an uncredited payment after a TERMINAL verification failure
   * (the only way the Pay button comes back). The on-chain transfer is NOT
   * undone — the UI says so plainly before the player proceeds. Pass the
   * tournament id to also drop the durable pending-payment record.
   */
  const clearPending = useCallback(
    (tournamentId?: string) => {
      attemptRef.current += 1; // cancel any in-flight poll loop
      setPendingTxHash(null);
      if (tournamentId) clearPendingEntryTx(tournamentId, playerId);
      setProgress(null);
      setError(null);
      setPhase("idle");
    },
    [playerId],
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
    clearPending,
    reset,
    busy:
      phase === "awaiting-wallet" || phase === "submitting" || phase === "verifying",
  };
}
