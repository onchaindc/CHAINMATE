import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  NimiqTxError,
  verifyIncomingTransaction,
  type VerifiedNimiqTransaction,
} from "@/lib/server/nimiq/transactions";
import { parseNim } from "@/lib/nimiq/format";
import { isPlausibleNimiqAddress } from "@/lib/nimiq/config";

export const runtime = "nodejs";

interface VerifyBody {
  playerId?: string;
  /** The on-chain transaction hash to verify. The ONLY client-supplied input. */
  txHash?: string;
  /**
   * Standalone-verification context. The AMOUNT the client may state here is
   * capped at a display-sized exact NIM string and is recorded as
   * kind='verification' — it can never redefine a payment obligation:
   * Phase 2B's tournament service will call verifyIncomingTransaction()
   * directly with its own expected amount, ignoring this field entirely.
   */
  expectedNim?: string;
  expectedRecipient?: string;
  tournamentId?: string;
}

/**
 * POST /api/nimiq/transactions/verify
 *
 * Authenticated through resolveActingPlayer like every ChainMate write. The
 * client supplies ONLY the transaction hash; sender comes from the linked
 * wallet (1B), recipient defaults to NIMIQ_TREASURY_ADDRESS, and the expected
 * amount for real obligations is always defined by the calling service —
 * never accepted from the request body.
 */
export async function POST(req: NextRequest) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  if (!body.txHash || typeof body.txHash !== "string") {
    return NextResponse.json({ error: "txHash is required" }, { status: 400 });
  }

  // The standalone endpoint lets a caller verify a specific payment they can
  // already describe exactly (a NIM string like "12.34"), but the amount is
  // parsed to exact luna server-side and capped small so this endpoint can
  // never be driven as a general "accept anything" ledger write. Real
  // obligations (entry fees) bypass this endpoint in 2B.
  let expectedAmountLuna: bigint;
  try {
    if (!body.expectedNim) {
      return NextResponse.json(
        {
          error:
            "expectedNim is required for standalone verification — the amount must be stated exactly (e.g. \"5\")",
        },
        { status: 400 },
      );
    }
    expectedAmountLuna = parseNim(body.expectedNim);
    if (expectedAmountLuna <= 0n || expectedAmountLuna > 1_000_000_000n) {
      throw new Error("amount out of the standalone verification range");
    }
    if (body.expectedRecipient && !isPlausibleNimiqAddress(body.expectedRecipient)) {
      throw new Error("expectedRecipient is not a valid Nimiq address");
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid expected amount" },
      { status: 400 },
    );
  }

  try {
    const verified: VerifiedNimiqTransaction = await verifyIncomingTransaction(body.txHash, {
      playerId: acting.playerId,
      expectedAmountLuna,
      expectedRecipient: body.expectedRecipient,
      kind: "verification",
      tournamentId: body.tournamentId,
    });
    // Response exposes only what the player already knows on-chain.
    return NextResponse.json({
      transaction: {
        txHash: verified.txHash,
        network: verified.network,
        sender: verified.sender,
        recipient: verified.recipient,
        amountLuna: verified.amountLuna,
        confirmations: verified.confirmations,
        blockNumber: verified.blockNumber,
        kind: verified.kind,
      },
    });
  } catch (err) {
    if (err instanceof NimiqTxError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
