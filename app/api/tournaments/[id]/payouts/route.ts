import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { getTournamentDoc } from "@/lib/server/tournament-store";
import { isPaidTournamentDoc } from "@/lib/server/tournament-economy-doc";
import { recomputeStandingsFor } from "@/lib/server/tournament-payouts-view";
import {
  PayoutTransitionError,
  listTournamentPayouts,
  planTournamentPayouts,
  retryPayout,
  sendPayout,
} from "@/lib/server/tournament-payouts";
import {
  PayoutDispatchError,
  dispatchPayout,
  verifyOutgoingPayout,
} from "@/lib/server/tournament-payouts-dispatch";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/tournaments/[id]/payouts — public payout lines for the detail
 * page (ranks, amounts, statuses). Destination addresses and treasury
 * internals are never exposed.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const payouts = await listTournamentPayouts(id);
    return NextResponse.json({
      payouts: payouts.map((p) => ({
        playerId: p.playerId,
        payoutRank: p.payoutRank,
        shareBps: p.shareBps,
        amountLuna: p.amountLuna,
        status: p.status,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load payouts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface PayoutActionBody {
  action: "plan" | "send" | "retry" | "dispatch" | "verify";
  playerId?: string;
  /** For send/dispatch/retry/verify: which winner's payout to act on. */
  targetPlayerId?: string;
}

/**
 * POST /api/tournaments/[id]/payouts — host-only payout actions.
 *   plan:  (re)create the payout records after completion (idempotent)
 *   send:  attempt dispatch through the configured treasury signer —
 *          typed 503 when none is configured (the 2B default)
 *   retry: return a failed/blocked payout to pending
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: PayoutActionBody;
  try {
    body = (await req.json()) as PayoutActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  try {
    const doc = await getTournamentDoc(id);
    if (!doc) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }
    if (doc.creatorId !== acting.playerId) {
      return NextResponse.json(
        { error: "Only the host can manage payouts" },
        { status: 403 },
      );
    }
    if (!isPaidTournamentDoc(doc)) {
      return NextResponse.json(
        { error: "This tournament has no prize pool" },
        { status: 400 },
      );
    }

    switch (body.action) {
      case "plan": {
        if (doc.status !== "completed") {
          return NextResponse.json(
            { error: "Payouts are planned only after the tournament completes" },
            { status: 409 },
          );
        }
        const standings = recomputeStandingsFor(doc);
        const result = await planTournamentPayouts(
          id,
          {
            preset: doc.prizePreset,
            standingsRanks: standings
              .filter((r) => r.rank <= 5)
              .map((r) => ({ rank: r.rank, playerId: r.playerId })),
          },
        );
        if ("skipped" in result) {
          return NextResponse.json({ skipped: result.skipped });
        }
        return NextResponse.json({
          created: result.created,
          prizePoolLuna: result.prizePoolLuna.toString(),
          allocatedLuna: result.allocatedLuna.toString(),
          dustLuna: result.dustLuna.toString(),
          payouts: result.payouts.map((p) => ({
            playerId: p.playerId,
            payoutRank: p.payoutRank,
            amountLuna: p.amountLuna,
            status: p.status,
          })),
        });
      }
      case "send": {
        if (!body.targetPlayerId) {
          return NextResponse.json({ error: "targetPlayerId is required" }, { status: 400 });
        }
        if (doc.status !== "completed") {
          return NextResponse.json(
            { error: "Payouts cannot be sent before the tournament completes" },
            { status: 409 },
          );
        }
        const payout = await sendPayout(id, body.targetPlayerId);
        return NextResponse.json({
          payout: {
            playerId: payout.playerId,
            status: payout.status,
            amountLuna: payout.amountLuna,
            payoutTxHash: payout.payoutTxHash,
          },
        });
      }
      case "dispatch": {
        if (!body.targetPlayerId) {
          return NextResponse.json({ error: "targetPlayerId is required" }, { status: 400 });
        }
        if (doc.status !== "completed") {
          return NextResponse.json(
            { error: "Payouts cannot be dispatched before the tournament completes" },
            { status: 409 },
          );
        }
        // The crash-safe path: write-ahead intent → broadcast → sent.
        const payout = await dispatchPayout(id, body.targetPlayerId);
        return NextResponse.json({
          payout: {
            playerId: payout.playerId,
            status: payout.status,
            amountLuna: payout.amountLuna,
            payoutTxHash: payout.payoutTxHash,
            validityStartHeight: payout.validityStartHeight ?? null,
            dispatchAttempts: payout.dispatchAttempts ?? 0,
          },
        });
      }
      case "verify": {
        if (!body.targetPlayerId) {
          return NextResponse.json({ error: "targetPlayerId is required" }, { status: 400 });
        }
        // Real on-chain verification: sender/recipient/value/success/confirmations.
        const payout = await verifyOutgoingPayout(id, body.targetPlayerId);
        return NextResponse.json({
          payout: {
            playerId: payout.playerId,
            status: payout.status,
            amountLuna: payout.amountLuna,
            payoutTxHash: payout.payoutTxHash,
            verifiedAt: payout.verifiedAt,
          },
        });
      }
      case "retry": {
        if (!body.targetPlayerId) {
          return NextResponse.json({ error: "targetPlayerId is required" }, { status: 400 });
        }
        const payout = await retryPayout(id, body.targetPlayerId);
        return NextResponse.json({
          payout: {
            playerId: payout.playerId,
            status: payout.status,
            amountLuna: payout.amountLuna,
          },
        });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof PayoutTransitionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof PayoutDispatchError) {
      return NextResponse.json(
        { error: err.message, kind: err.kind },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Payout action failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
