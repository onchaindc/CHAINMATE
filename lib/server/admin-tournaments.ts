// Server-only module — never import from client components.

/**
 * Admin tournament operations.
 *
 * The operator's view and the overrides the host path cannot do: listing
 * EVERY tournament (any host, any status) with entry and money detail, and
 * force-cancel / force-complete / force-delete for the stuck-event cases —
 * a vanished host, a round that never advanced, an event that must close
 * with money in it.
 *
 * Admin means "allowed where the host cannot act", NOT "exempt from the
 * rules": the lifecycle and money invariants all still hold. Force-cancel
 * of a paid event records refund_required exactly as the host path does.
 * Force-delete refuses while third-party paid seats exist — refund first,
 * because deleting a tournament that holds real funds would orphan them.
 * Every write runs inside the same durable tournament lock as the host
 * path, so an admin action can never race a join or a game result.
 */

import { isAdminPlayer, usernameForPlayer } from "@/lib/server/admin";
import {
  computeKnockoutStandings,
  computeStandings,
} from "@/lib/tournament-standings";
import { formatNim } from "@/lib/nimiq/format";
import {
  getTournamentDoc,
  transitionTournamentStatus,
  withTournamentLock,
  writeTournamentDoc,
} from "@/lib/server/tournament-store";
import { getVerifiedPrizePool, listPaidEntries } from "@/lib/server/tournament-economy";
import { isPaidTournamentDoc } from "@/lib/server/tournament-economy-doc";
import { listTournaments } from "@/lib/server/tournaments";

export interface AdminPayoutLine {
  playerId: string;
  playerName: string | null;
  payoutRank: number;
  shareBps: number;
  amountLuna: string;
  status: string;
  destinationAddress: string | null;
}

export interface AdminRefundLine {
  playerId: string;
  playerName: string | null;
  amountLuna: string;
  status: string;
}

export interface AdminTournamentRow {
  id: string;
  name: string;
  status: string;
  format: string;
  hostPlayerId: string;
  hostName: string | null;
  entries: number;
  paidEntries: number;
  prizePoolNim: string | null;
  entryFeeNim: string | null;
  createdAt: number;
  startedAt: number | null;
  /** Aggregate money state (none | pending | partial | paid | refund_required | refunded). */
  payoutStatus: string;
  /** Prize distribution preset ("winner" | "top3" | "top5" | null). */
  prizePreset: string | null;
  /** Per-rank payout rows (completed paid events) — the purse to settle. */
  payouts: AdminPayoutLine[];
  /** Outstanding refund obligations (cancel / leave-before-lock). */
  refunds: AdminRefundLine[];
}

/** Every tournament for the admin table, host names and money attached. */
export async function listAllTournamentsForAdmin(limit = 100): Promise<AdminTournamentRow[]> {
  const { tournaments } = await listTournaments({ limit });
  const { listTournamentPayouts } = await import("@/lib/server/tournament-payouts");
  const rows: AdminTournamentRow[] = [];
  for (const t of tournaments) {
    const doc = await getTournamentDoc(t.id);
    if (!doc) continue;
    const active = doc.entries.filter((e) => e.leftAt === undefined);
    const paid = active.filter((e) => e.paid);
    // Money in the event: a paid entry fee, or a pool the operator topped
    // up from this console (free events can carry a purse too).
    const verifiedPoolLuna = await getVerifiedPrizePool(doc.id).catch(() => 0n);
    const moneyed = isPaidTournamentDoc(doc) || verifiedPoolLuna > 0n;


    // Payout purse + refunds: the admin dashboard is ChainMate's settlement
    // console, so every completed/cancelled paid event carries its rows here.
    // Names resolve for EVERY row (not just the host's) — a console showing
    // raw `acct_…` ids is a debugging view, not an operator view.
    let payoutLines: AdminPayoutLine[] = [];
    if (moneyed && (doc.status === "completed" || doc.status === "cancelled")) {
      try {
        const records = await listTournamentPayouts(doc.id);
        payoutLines = [];
        for (const p of records) {
          payoutLines.push({
            playerId: p.playerId,
            playerName: await usernameForPlayer(p.playerId),
            payoutRank: p.payoutRank,
            shareBps: p.shareBps,
            amountLuna: p.amountLuna,
            status: p.status,
            destinationAddress: p.destinationAddress ?? null,
          });
        }
      } catch {
        payoutLines = [];
      }
    }
    const refundLines: AdminRefundLine[] = doc.refunds
      ? await Promise.all(
          Object.values(doc.refunds).map(async (r) => ({
            playerId: r.playerId,
            playerName: await usernameForPlayer(r.playerId),
            amountLuna: r.amountLuna,
            status: r.status,
          })),
        )
      : [];

    rows.push({
      id: doc.id,
      name: doc.name,
      status: doc.status,
      format: doc.format,
      hostPlayerId: doc.creatorId,
      hostName: await usernameForPlayer(doc.creatorId),
      entries: active.length,
      paidEntries: paid.length,
      entryFeeNim: isPaidTournamentDoc(doc) && doc.entryFeeLuna ? formatNim(BigInt(doc.entryFeeLuna)) : null,
      prizePoolNim: moneyed ? formatNim(verifiedPoolLuna) : null,
      createdAt: doc.createdAt,
      startedAt: doc.startedAt,
      payoutStatus: doc.payoutStatus ?? "none",
      prizePreset: doc.prizePreset ?? null,
      payouts: payoutLines,
      refunds: refundLines,
    });
  }
  return rows;
}

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** Standings straight from the same engine functions the host path uses. */
function standingsOf(doc: NonNullable<Awaited<ReturnType<typeof getTournamentDoc>>>) {
  const active = doc.entries.filter((e) => e.leftAt === undefined);
  return doc.format === "knockout"
    ? computeKnockoutStandings(doc.matches, active)
    : computeStandings(doc.format, doc.matches, active);
}

/**
 * Force-cancel: any live state → cancelled, with the SAME refund
 * bookkeeping the host path applies to paid events.
 */
export async function adminCancelTournament(
  adminPlayerId: string,
  tournamentId: string,
): Promise<AdminActionResult> {
  if (!(await isAdminPlayer(adminPlayerId))) return { ok: false, error: "Not found" };
  return withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return { ok: false, error: "Tournament not found" };
    if (doc.status === "completed" || doc.status === "cancelled") {
      return { ok: false, error: `Tournament is already ${doc.status}` };
    }
    const won = await transitionTournamentStatus(tournamentId, doc.status, "cancelled");
    if (!won) return { ok: false, error: "State changed concurrently; try again" };
    doc.status = "cancelled";
    doc.cancelReason = doc.cancelReason ?? `Cancelled by a ChainMate administrator.`;
    if (isPaidTournamentDoc(doc)) {
      try {
        const paid = await listPaidEntries(tournamentId);
        if (paid.length > 0) {
          // The SAME materialisation the host path uses: one durable refund
          // obligation per verified entrant (idempotent per player), so the
          // host's refund UI has real rows to settle — not just a flag.
          doc.refunds = doc.refunds ?? {};
          for (const p of paid) {
            if (!doc.refunds[p.playerId]) {
              doc.refunds[p.playerId] = {
                playerId: p.playerId,
                entryTxHash: p.txHash,
                amountLuna: p.amountLuna.toString(),
                status: "owed",
                refundTxHash: null,
                attempts: 0,
                lastError: null,
                createdAt: Date.now(),
                verifiedAt: null,
              };
            }
          }
          doc.payoutStatus = "refund_required";
        }
      } catch {
        doc.payoutStatus = "refund_required";
      }
    }
    await writeTournamentDoc(doc);
    // Mirror the freshly written refund rows (after the document persists,
    // never outpacing the fast store).
    if (doc.refunds) {
      const { mirrorRefund } = await import("@/lib/server/tournament-store");
      for (const r of Object.values(doc.refunds)) {
        await mirrorRefund(tournamentId, r).catch(() => undefined);
      }
    }
    return { ok: true, message: `Cancelled "${doc.name}". Entry fees are queued for return.` };
  });
}

/**
 * Force-complete: freeze a running event now. Standings come from the
 * engine as-is; paid events run the same idempotent payout planning as
 * normal completion. This is the vanished-host rescue.
 */
export async function adminCompleteTournament(
  adminPlayerId: string,
  tournamentId: string,
): Promise<AdminActionResult> {
  if (!(await isAdminPlayer(adminPlayerId))) return { ok: false, error: "Not found" };
  return withTournamentLock(tournamentId, async () => {
    const doc = await getTournamentDoc(tournamentId);
    if (!doc) return { ok: false, error: "Tournament not found" };
    if (doc.status !== "in_progress") {
      return { ok: false, error: `Only a running tournament can be completed (this one is ${doc.status})` };
    }
    const won = await transitionTournamentStatus(tournamentId, "in_progress", "completed");
    if (!won) return { ok: false, error: "State changed concurrently; try again" };
    doc.status = "completed";
    doc.completedAt = Date.now();
    doc.standings = standingsOf(doc);
    await writeTournamentDoc(doc);
    if (isPaidTournamentDoc(doc) && doc.prizePreset) {
      try {
        const { planTournamentPayouts } = await import("@/lib/server/tournament-payouts");
        const result = await planTournamentPayouts(
          tournamentId,
          {
            preset: doc.prizePreset,
            standingsRanks: doc.standings
              .filter((r) => r.rank <= 5)
              .map((r) => ({ rank: r.rank, playerId: r.playerId })),
          },
          {
            getPrizePool: (id: string) => getVerifiedPrizePool(id),
            getWallet: async (playerId: string) => {
              const { getLinkedWallet } = await import("@/lib/server/nimiq/service");
              return getLinkedWallet(playerId);
            },
          },
        );
        if ("created" in result && result.created > 0) {
          doc.payoutStatus = "pending";
          await writeTournamentDoc(doc);
        }
      } catch {
        // Payout planning can be re-run; completion stands.
      }
    }
    return { ok: true, message: `Completed "${doc.name}"; standings frozen.` };
  });
}

/**
 * Force-delete: removes the event entirely. Refuses while third-party paid
 * seats exist — refunds must be resolved first — and never while running
 * (complete or cancel it first so standings/payouts are handled).
 */
export async function adminDeleteTournament(
  adminPlayerId: string,
  tournamentId: string,
): Promise<AdminActionResult> {
  if (!(await isAdminPlayer(adminPlayerId))) return { ok: false, error: "Not found" };
  const doc = await getTournamentDoc(tournamentId);
  if (!doc) return { ok: false, error: "Tournament not found" };
  if (doc.status === "in_progress") {
    return { ok: false, error: "The tournament is running: complete or cancel it before deleting" };
  }
  // deleteTournament already encodes the paid-entry refusal and the admin
  // bypass; calling it with the verified admin id keeps one delete path.
  const res = await deleteTournamentChecked(adminPlayerId, tournamentId);
  if (!res.ok) return { ok: false, error: res.error ?? "Delete failed" };
  return { ok: true, message: `Deleted "${doc.name}".` };
}

async function deleteTournamentChecked(
  adminPlayerId: string,
  tournamentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { deleteTournament } = await import("@/lib/server/tournaments");
  const res = await deleteTournament(tournamentId, adminPlayerId);
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "Delete failed" };
}
