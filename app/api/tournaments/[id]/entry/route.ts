import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  SeatCreationError,
  TournamentEntryError,
  joinPaidTournament,
} from "@/lib/server/tournament-economy";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

interface EntryBody {
  playerId?: string;
  /** The ONLY client input that matters: the hash of the tx the player sent. */
  txHash?: string;
}

/**
 * POST /api/tournaments/[id]/entry — pay to join a PAID tournament.
 *
 * Flow (real NIM, real verification):
 *   1. resolveActingPlayer authenticates the player (a bare playerId from
 *      the body is never authority).
 *   2. The TOURNAMENT RECORD defines the exact fee + treasury recipient.
 *   3. Phase 1C verifyIncomingTransaction() checks the real on-chain
 *      transaction (sender = linked wallet, recipient = treasury, value =
 *      fee, confirmations, replay) and records kind='tournament_entry'.
 *   4. Only then is the entry marked paid.
 *
 * Errors are typed: insufficient confirmations come back as a retryable
 * 409/502 with the precise reason, never as a successful join.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: EntryBody;
  try {
    body = (await req.json()) as EntryBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  try {
    const result = await joinPaidTournament(id, acting.playerId, body.txHash ?? "");
    return NextResponse.json({
      ok: true,
      entry: {
        txHash: result.txHash,
        amountLuna: result.entry.amountLuna.toString(),
        network: result.entry.network,
        verifiedAt: result.entry.verifiedAt,
      },
    });
  } catch (err) {
    if (err instanceof SeatCreationError) {
      // The tx WAS consumed but no seat exists. 500 + the hash: the payment
      // is traceable and support can self-heal by resubmitting the same hash.
      return NextResponse.json(
        { error: err.message, kind: err.kind, consumedTxHash: err.consumedTxHash },
        { status: err.status },
      );
    }
    if (err instanceof TournamentEntryError) {
      return NextResponse.json(
        { error: err.message, kind: err.kind },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Entry payment failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
