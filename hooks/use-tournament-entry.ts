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
 */

import { useCallback, useState } from "react";

import {
  connectNimiq,
  sendNimiqBasicTransaction,
} from "@/lib/nimiq/miniapp";
import { parseNim } from "@/lib/nimiq/format";
import { useNimiqWallet } from "@/hooks/use-nimiq-wallet";
import { tournamentApi } from "@/lib/tournament-api";

export type EntryPhase =
  | "idle"
  | "awaiting-wallet"
  | "submitting"
  | "verifying"
  | "joined"
  | "error";

export function useTournamentEntry(playerId: string) {
  const wallet = useNimiqWallet(playerId);
  const [phase, setPhase] = useState<EntryPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  /**
   * Pay the entry fee and join. `entryFeeNim` is the DISPLAY string from the
   * tournament summary — parsed to exact luna here only to populate the
   * wallet transaction; the server independently verifies the amount from
   * the tournament record, so a tampered client cannot underpay.
   */
  const payAndJoin = useCallback(
    async (tournamentId: string, entryFeeNim: string) => {
      if (phase === "awaiting-wallet" || phase === "submitting" || phase === "verifying") {
        return; // duplicate-click guard
      }
      setError(null);

      if (!wallet.wallet) {
        setError("Link your Nimiq wallet first.");
        setPhase("error");
        return;
      }

      let feeLuna: bigint;
      try {
        feeLuna = parseNim(entryFeeNim);
      } catch {
        setError("This tournament's entry fee is invalid.");
        setPhase("error");
        return;
      }

      setPhase("awaiting-wallet");
      try {
        const connected = await connectNimiq();
        if (!connected.ok) throw new Error(connected.error.message);

        // Real NIM transfer to the treasury. The RECIPIENT is the configured
        // treasury address from Phase 1A config — the same address the
        // server verifies against. Never a client-chosen address.
        const { NIMIQ_TREASURY_ADDRESS } = await import("@/lib/nimiq/config");
        if (!NIMIQ_TREASURY_ADDRESS) {
          throw new Error("NIM treasury is not configured for this deployment.");
        }
        const sent = await sendNimiqBasicTransaction(connected.value, {
          recipient: NIMIQ_TREASURY_ADDRESS,
          value: feeLuna,
        });
        if (!sent.ok) throw new Error(sent.error.message);
        const txHash = sent.value;

        // Server verifies the real transaction (sender/recipient/amount/
        // confirmations/replay) and only then marks the entry paid.
        setPhase("verifying");
        await tournamentApi.submitEntryTx(tournamentId, playerId, txHash);
        setPhase("joined");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Payment failed");
        setPhase("error");
      }
    },
    [phase, playerId, wallet.wallet],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  return {
    wallet,
    phase,
    error,
    payAndJoin,
    reset,
    busy:
      phase === "awaiting-wallet" || phase === "submitting" || phase === "verifying",
  };
}
