// Server-only module — never import from client components.

/**
 * Payment-proof verification — server side of the proof-of-signer fix.
 *
 * The client embeds a signed payment intent in the transaction's data field
 * (see lib/nimiq/proof.ts for why this exists: Nimiq Pay picks the on-chain
 * sender itself, so the sender field cannot attribute a payment).
 *
 * THE KEY DESIGN RULE: the server never parses or trusts a client-supplied
 * intent. It RECONSTRUCTS the exact expected intent from the verification
 * obligation (player, tournament, exact fee, canonical treasury, network —
 * every field already established server-side) and checks the wallet's
 * signature against THAT. A proof therefore only ever verifies when the
 * linked wallet's key signed exactly the payment the server was expecting:
 *
 *   1. Ed25519 signature over the deterministic intent message
 *      (Nimiq's canonical message-signing framing, the same convention the
 *      wallet applies to every sign() request — verified in Phase 1B).
 *   2. The address derived from the proven public key IS the player's
 *      linked wallet (Blake2b derivation — the identical rule that made the
 *      Phase 1B binding trustworthy).
 *
 * Only the linked wallet's key can produce such a signature, so a verified
 * proof attributes the payment to the linked wallet no matter which
 * wrapper/intermediary account Nimiq Pay used as the on-chain sender.
 */

import { addressFromPublicKey, canonicalAddress } from "@/lib/server/nimiq/verify";
import { verifyChallengeSignature } from "@/lib/server/nimiq/verify";
import {
  proofMessage,
  type PaymentProof,
} from "@/lib/nimiq/proof";
import type { NimiqNetworkName } from "@/lib/nimiq/config";

/** What the proof must attest to — exactly the server's own obligation. */
export interface ProofExpectation {
  playerId: string;
  tournamentId: string;
  /** Exact fee in luna (bigint). */
  expectedAmountLuna: bigint;
  /** Canonical treasury address the payment must go to. */
  expectedRecipient: string;
  network: NimiqNetworkName;
  /** The player's linked wallet address (canonical form). */
  linkedAddress: string;
}

export type ProofVerdict =
  | { ok: true }
  | {
      ok: false;
      /** Machine-readable reason for logs/tests. */
      reason:
        | "malformed-proof"
        | "signature-invalid"
        | "key-not-linked-wallet";
      /** Human-readable explanation (safe to show/log — no secrets). */
      message: string;
    };

/**
 * Verify that `proof` is a signature by the player's linked wallet over the
 * exact payment intent this obligation describes. Never touches the network;
 * pure crypto over server-established facts.
 */
export async function verifyPaymentProof(
  proof: PaymentProof,
  expectation: ProofExpectation,
): Promise<ProofVerdict> {
  const message = proofMessage({
    playerId: expectation.playerId,
    tournamentId: expectation.tournamentId,
    amountLuna: expectation.expectedAmountLuna.toString(),
    recipient: canonicalAddress(expectation.expectedRecipient),
    network: expectation.network,
  });

  let signatureValid: boolean;
  try {
    signatureValid = await verifyChallengeSignature({
      message,
      signatureHex: proof.signature,
      publicKeyHex: proof.publicKey,
    });
  } catch {
    return {
      ok: false,
      reason: "malformed-proof",
      message: "The embedded payment proof is malformed",
    };
  }
  if (!signatureValid) {
    return {
      ok: false,
      reason: "signature-invalid",
      message: "The payment proof signature does not match the expected payment",
    };
  }

  let provenAddress: string;
  try {
    provenAddress = canonicalAddress(addressFromPublicKey(proof.publicKey));
  } catch {
    return {
      ok: false,
      reason: "malformed-proof",
      message: "The payment proof public key is malformed",
    };
  }
  if (provenAddress !== canonicalAddress(expectation.linkedAddress)) {
    return {
      ok: false,
      reason: "key-not-linked-wallet",
      message: "The payment proof was not signed by your linked wallet's key",
    };
  }

  return { ok: true };
}
