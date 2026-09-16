"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowRight,
  Coins,
  Crown,
  Loader2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Swords,
  Timer,
  Trophy,
  UserMinus,
  UserPlus,
  Wallet,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader, SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { guestDisplayName } from "@/lib/identity";
import { tournamentApi, type TournamentDetailPayload, type TournamentAction } from "@/lib/tournament-api";
import type { TournamentFormat, TournamentMatch, TournamentStatus } from "@/lib/tournament-types";
import { formatNim } from "@/lib/nimiq/format";
import { isNimiqEnabled } from "@/lib/nimiq/flag";
import { useTournamentEntry } from "@/hooks/use-tournament-entry";
import { shortNimiqAddress } from "@/hooks/use-nimiq-wallet";
import { cn } from "@/lib/utils";

/**
 * Tournament detail — one event, everything on one page: header with
 * join/leave (or the paid entry flow), host controls, the current round or
 * live arena games, the standings, and — for paid events — the prize pool
 * and payout state. Polls like the rest of the app.
 */

/** Exact luna string → human NIM (display only). */
function displayNim(luna: string | null | undefined): string {
  if (!luna) return "0";
  try {
    return formatNim(BigInt(luna));
  } catch {
    return luna;
  }
}

const STATUS_LABEL: Record<TournamentStatus, string> = {
  draft: "Draft — not open yet",
  registration: "Registration open",
  locked: "Registration locked",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const FORMAT_LABEL: Record<TournamentFormat, string> = {
  knockout: "Knockout",
  swiss: "Swiss",
  arena: "Arena",
};

/** Map a server error to friendlier copy where the engine's wording is terse. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/already joined/i.test(msg)) return "You're already in this tournament.";
  return msg;
}

export default function TournamentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const identity = useIdentity();

  const [detail, setDetail] = useState<TournamentDetailPayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<TournamentAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [payoutBusy, setPayoutBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await tournamentApi.detail(id, identity.playerId || undefined);
      setDetail(data);
      setNotFound(false);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load";
      if (/not found/i.test(msg)) setNotFound(true);
      setError(msg);
    }
  }, [id, identity.playerId]);

  useEffect(() => {
    if (identity.status === "loading") return;
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load, identity.status]);

  const act = async (action: TournamentAction) => {
    if (!detail) return;
    setBusy(action);
    setActionError(null);
    try {
      await tournamentApi.action(id, identity.playerId, action);
      await load();
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  // Hooks before any early return (rules-of-hooks): the paid-entry flow is
  // only USED for paid tournaments, but it is always INSTANTIATED.
  const entry = useTournamentEntry(identity.playerId);
  /** Reload recovery armed until the first detail load decides on it. */
  const [resumeChecked, setResumeChecked] = useState(false);

  /** Host-only payout dispatch/verify — crash-safe on the server. */
  const runPayoutAction = async (action: "dispatch" | "verify", targetPlayerId: string) => {
    if (!detail || payoutBusy) return;
    setPayoutBusy(`${action}:${targetPlayerId}`);
    setActionError(null);
    try {
      await tournamentApi.payoutAction(id, identity.playerId, action, targetPlayerId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Payout action failed");
    } finally {
      setPayoutBusy(null);
    }
  };

  /**
   * Reload recovery: if the player paid (a pending tx is stored) but left
   * during the confirmation window, resume verification for the SAME hash —
   * never a second payment. Runs once, after the first detail load tells us
   * whether the seat is still unpaid.
   */
  useEffect(() => {
    if (!detail || resumeChecked || !identity.playerId) return;
    setResumeChecked(true);
    const stored = readPendingTx(id);
    if (!stored) return;
    const feeLuna = s.entryFeeLuna && s.entryFeeLuna !== "0" ? s.entryFeeLuna : null;
    const myEntry = detail.entries.find((e) => e.playerId === identity.playerId);
    const stillUnpaid =
      feeLuna !== null &&
      detail.myRole === "entrant" &&
      !myEntry?.paid &&
      detail.summary.status === "registration";
    if (stillUnpaid) {
      entry.setPendingTxHash(stored);
      void entry.reverify(id, stored);
    } else {
      storePendingTx(id, null); // seat confirmed or gone — nothing pending
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, resumeChecked, identity.playerId]);

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <Panel>
          <EmptyState
            icon={Trophy}
            title="Tournament not found"
            description="It may have been removed, or the link is wrong."
            action={{ href: "/tournaments", label: "Back to tournaments" }}
          />
        </Panel>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <Panel className="animate-fade-in-up">
          <LoadingRows rows={5} />
        </Panel>
        {error && <ErrorNote message={error} className="mt-4" />}
      </div>
    );
  }

  const s = detail.summary;
  const isHost = detail.myRole === "host";
  const isEntrant = detail.myRole === "entrant";
  const joined = isEntrant;
  const entryFeeLuna = s.entryFeeLuna && s.entryFeeLuna !== "0" ? s.entryFeeLuna : null;
  const isPaid = entryFeeLuna !== null;
  const myEntry = detail.entries.find((e) => e.playerId === identity.playerId);
  const myPaymentPending = isPaid && joined && !myEntry?.paid && s.status === "registration";
  const canJoin =
    s.status === "registration" && !joined && s.playerCount < s.maxPlayers;
  const canLeave = s.status === "registration" && joined && !entry.busy;
  const full = s.playerCount >= s.maxPlayers;
  const showStandings =
    s.status === "in_progress" || s.status === "completed" || detail.standings.some((r) => r.played > 0);
  const winnerRow = detail.standings.find((r) => r.playerId === s.winnerId);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      {/* ---------- Header ---------- */}
      <PageHeader
        eyebrow={FORMAT_LABEL[s.format]}
        title={s.name}
        description={s.description || undefined}
        actions={
          <div className="flex items-center gap-2">
            {canJoin && !isPaid && (
              <Button size="sm" disabled={busy !== null} onClick={() => void act("join")}>
                {busy === "join" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <UserPlus aria-hidden />
                )}
                Join
              </Button>
            )}
            {canLeave && !isPaid && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void act("leave")}
              >
                {busy === "leave" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <UserMinus aria-hidden />
                )}
                Leave
              </Button>
            )}
            {joined && s.status === "in_progress" && s.format === "arena" && !detail.myActiveGameId && (
              <Button size="sm" disabled={busy !== null} onClick={() => void act("pair")}>
                {busy === "pair" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Swords aria-hidden />
                )}
                Find opponent
              </Button>
            )}
            {detail.myActiveGameId && (
              <Link href={`/game/${detail.myActiveGameId}`} className={cn(buttonVariants({ size: "sm" }))}>
                Resume game
                <ArrowRight aria-hidden />
              </Link>
            )}
          </div>
        }
      />

      {/* ---------- Facts strip ---------- */}
      <div className="animate-fade-in-up mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border/70 bg-card/40 px-4 py-3 font-mono text-xs tabular-nums text-muted-foreground [animation-delay:40ms]">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-sans text-2xs font-semibold uppercase tracking-wider",
            s.status === "registration" && "text-primary",
            s.status === "in_progress" && "text-primary",
            s.status === "cancelled" && "text-destructive",
          )}
        >
          {(s.status === "in_progress" || s.status === "registration") && (
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" aria-hidden />
          )}
          {STATUS_LABEL[s.status]}
        </span>
        <span className="inline-flex items-center gap-1">
          <UsersIcon />
          {s.playerCount}/{s.maxPlayers}
          {full && s.status === "registration" && (
            <span className="font-sans text-2xs text-warning"> · full</span>
          )}
        </span>
        <span className="inline-flex items-center gap-1">
          <Timer className="h-3.5 w-3.5" aria-hidden />
          {s.timeControl}
        </span>
        {s.format !== "arena" && s.totalRounds ? (
          <span>
            Round {s.currentRound ?? 0}/{s.totalRounds}
          </span>
        ) : null}
        {s.registrationClosesAt && s.status === "registration" && (
          <span>Closes {new Date(s.registrationClosesAt).toLocaleString()}</span>
        )}
        {entryFeeLuna ? (
          <span className="inline-flex items-center gap-1 text-foreground/80">
            <Coins className="h-3.5 w-3.5" aria-hidden />
            Entry {displayNim(entryFeeLuna)} NIM
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Coins className="h-3.5 w-3.5" aria-hidden />
            Free entry
          </span>
        )}
        {isHost && <span className="font-sans text-2xs text-primary">You host</span>}
      </div>

      {actionError && <ErrorNote message={actionError} className="mt-4" />}

      {/* ---------- Paid entry panel (Phase 2B) ---------- */}
      {isPaid && isNimiqEnabled() && (
        <PaidEntryPanel
          detail={detail}
          entryFeeLuna={entryFeeLuna!}
          joined={joined}
          paymentPending={myPaymentPending}
          entry={entry}
          onJoined={() => {
            storePendingTx(id, null);
            void load();
          }}
        />
      )}
      {isPaid && !isNimiqEnabled() && !joined && s.status === "registration" && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning">
          <Coins className="h-4 w-4 shrink-0" aria-hidden />
          This is a paid tournament (entry: {displayNim(entryFeeLuna)} NIM) but NIM
          features are not enabled in this deployment.
        </div>
      )}

      {/* ---------- Host controls ---------- */}
      {isHost && (
        <Panel className="animate-fade-in-up mt-4 [animation-delay:60ms]">
          <div className="flex flex-wrap items-center gap-2 p-3">
            <span className="mr-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Host controls
            </span>
            {s.status === "draft" && (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act("open-registration")}>
                Open registration
              </Button>
            )}
            {s.status === "registration" && (
              <>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("lock")}>
                  Lock registration
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || s.playerCount < 2}
                  onClick={() => void act("start")}
                  title={s.playerCount < 2 ? "Need at least 2 players" : undefined}
                >
                  {busy === "start" ? <Loader2 className="animate-spin" aria-hidden /> : <Swords aria-hidden />}
                  Start
                </Button>
              </>
            )}
            {s.status === "locked" && (
              <>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("reopen-registration")}>
                  Reopen registration
                </Button>
                <Button size="sm" disabled={busy !== null} onClick={() => void act("start")}>
                  {busy === "start" ? <Loader2 className="animate-spin" aria-hidden /> : <Swords aria-hidden />}
                  Start
                </Button>
              </>
            )}
            {s.status === "in_progress" && (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act("complete")}>
                End &amp; finalise
              </Button>
            )}
            {s.status !== "completed" && s.status !== "cancelled" && (
              <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void act("cancel")}>
                Cancel
              </Button>
            )}
            {s.status === "completed" && s.winnerId && (
              <span className="inline-flex items-center gap-1.5 text-sm text-primary">
                <Crown className="h-4 w-4" aria-hidden />
                Winner: {nameOf(detail, s.winnerId)}
              </span>
            )}
          </div>
        </Panel>
      )}

      {/* ---------- Winner banner (completed) ---------- */}
      {s.status === "completed" && s.winnerId && !isHost && (
        <div className="animate-fade-in-up mt-4 flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 [animation-delay:60ms]">
          <Trophy className="h-5 w-5 text-primary" aria-hidden />
          <p className="text-sm">
            <span className="font-semibold">{nameOf(detail, s.winnerId)}</span>
            <span className="text-muted-foreground"> wins the tournament</span>
            {winnerRow && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {" "}· {winnerRow.wins}W {winnerRow.draws}D {winnerRow.losses}L · {winnerRow.points} pts
              </span>
            )}
          </p>
        </div>
      )}

      {/* ---------- Current round / live matches ---------- */}
      {detail.rounds.length > 0 && (
        <section className="animate-fade-in-up mt-8 [animation-delay:80ms]">
          <SectionLabel live={detail.rounds.some((r) => r.open)}>Matches</SectionLabel>
          <div className="mt-3 space-y-4">
            {[...detail.rounds].reverse().map((round) => (
              <div key={round.index}>
                <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {round.label}
                </p>
                <div className="mt-2 divide-y divide-border/50 overflow-hidden rounded-lg border border-border/70 bg-card/50">
                  {round.matches.map((m) => (
                    <MatchRow
                      key={m.id}
                      match={m}
                      detail={detail}
                      me={identity.playerId}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Arena: live games (round 0) */}
      {s.format === "arena" && s.status === "in_progress" && (
        <section className="animate-fade-in-up mt-8 [animation-delay:80ms]">
          <SectionLabel live>Arena</SectionLabel>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Find an opponent above whenever you&rsquo;re free — one active game at a
            time. Every finished game updates the standings immediately.
          </p>
          {detail.rounds.length > 0 && (
            <div className="mt-3 divide-y divide-border/50 overflow-hidden rounded-lg border border-border/70 bg-card/50">
              {detail.rounds[0].matches.map((m) => (
                <MatchRow key={m.id} match={m} detail={detail} me={identity.playerId} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---------- Standings ---------- */}
      {showStandings && (
        <section className="animate-fade-in-up mt-8 [animation-delay:120ms]">
          <SectionLabel live={s.status === "in_progress"}>
            Standings
            <span className="ml-2 font-sans text-2xs normal-case tracking-normal text-muted-foreground/70">
              {s.format === "knockout" ? "by bracket position" : "1 / ½ / 0"}
            </span>
          </SectionLabel>
          <Panel className="mt-3">
            {detail.standings.length === 0 ? (
              <EmptyState title="No games played yet" className="py-10" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[24rem] table-fixed text-sm">
                  <thead>
                    <tr className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <th className="w-10 bg-card px-3 py-2 text-right">#</th>
                      <th className="bg-card px-3 py-2 text-left">Player</th>
                      <th className="w-12 bg-card px-2 py-2 text-right">W</th>
                      <th className="w-12 bg-card px-2 py-2 text-right">D</th>
                      <th className="w-12 bg-card px-2 py-2 text-right">L</th>
                      <th className="w-14 bg-card px-3 py-2 text-right">Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.standings.map((row) => {
                      const isMe = row.playerId === identity.playerId;
                      return (
                        <tr
                          key={row.playerId}
                          className={cn(
                            "border-b border-border/40 last:border-0",
                            isMe && "bg-primary/5",
                            row.playerId === s.winnerId && s.status === "completed" && "bg-primary/10",
                          )}
                        >
                          <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                            {row.eliminatedInRound != null
                              ? `R${row.eliminatedInRound}`
                              : row.rank}
                          </td>
                          <td className="px-3 py-2">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-sm font-medium text-foreground/90">
                                {nameOf(detail, row.playerId)}
                              </span>
                              {isMe && (
                                <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-primary">
                                  you
                                </span>
                              )}
                              {row.playerId === s.winnerId && s.status === "completed" && (
                                <Crown className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                              )}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-xs tabular-nums">{row.wins}</td>
                          <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">{row.draws}</td>
                          <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">{row.losses}</td>
                          <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-primary">
                            {row.points}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {s.format === "swiss" && detail.standings.length > 1 && (
            <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
              Rank: points, then Buchholz (opponents&rsquo; scores), then wins,
              then head-to-head, then registration order.
            </p>
          )}
          {s.format === "arena" && detail.standings.length > 1 && (
            <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
              Rank: points, then win rate, then Buchholz.
            </p>
          )}
        </section>
      )}

      {/* ---------- Participants (registration phase) ---------- */}
      {(s.status === "draft" || s.status === "registration" || s.status === "locked") && (
        <section className="animate-fade-in-up mt-8 [animation-delay:160ms]">
          <SectionLabel aside={`${detail.entries.length} of ${s.maxPlayers}`}>
            Participants
          </SectionLabel>
          <Panel className="mt-3">
            {detail.entries.length === 0 ? (
              <EmptyState
                title="Nobody has joined yet"
                description={
                  s.status === "draft"
                    ? "Registration hasn't opened."
                    : "Be the first — hit Join."
                }
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-border/50">
                {detail.entries.map((e, i) => (
                  <li key={e.playerId} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-6 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {nameOf(detail, e.playerId)}
                      {e.playerId === identity.playerId && (
                        <span className="ml-1.5 text-2xs uppercase tracking-wider text-primary">you</span>
                      )}
                    </span>
                    {e.playerId === s.creatorId && (
                      <span className="text-2xs uppercase tracking-wider text-muted-foreground">host</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      )}

      {/* ---------- Payouts (completed paid tournaments) ---------- */}
      {isPaid && detail.payouts && detail.payouts.length > 0 && (
        <section className="animate-fade-in-up mt-8 [animation-delay:140ms]">
          <SectionLabel>Purse &amp; payouts</SectionLabel>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs leading-relaxed text-muted-foreground">
            <span>
              Prize pool: <strong className="font-mono tabular-nums text-foreground">{displayNim(totalPool(detail.payouts))} NIM</strong>
              {" "}from verified entries ({s.prizePreset === "top3" ? "60/25/15" : s.prizePreset === "top5" ? "45/25/15/10/5" : "winner takes all"})
            </span>
            <PayoutStateBadge status={s.payoutStatus ?? "none"} />
          </p>
          <Panel className="mt-3">
            <ul className="divide-y divide-border/50">
              {detail.payouts.map((p) => (
                <li key={p.playerId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <span className="w-6 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {p.payoutRank}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {nameOf(detail, p.playerId)}
                    {p.playerId === identity.playerId && (
                      <span className="ml-1.5 text-2xs uppercase tracking-wider text-primary">you</span>
                    )}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{p.shareBps / 100}%</span>
                  <span className="w-20 text-right font-mono text-xs font-semibold tabular-nums text-primary">
                    {displayNim(p.amountLuna)} NIM
                  </span>
                  <PayoutStatusPill status={p.status} />
                  {isHost &&
                    (p.status === "pending" || p.status === "failed" || p.status === "dispatching") && (
                      <button
                        type="button"
                        disabled={payoutBusy !== null}
                        onClick={() => void runPayoutAction("dispatch", p.playerId)}
                        className="shrink-0 rounded border border-border/70 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-foreground/80 transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
                      >
                        {p.status === "dispatching" ? "reconcile" : "dispatch"}
                      </button>
                    )}
                  {isHost && p.status === "sent" && (
                    <button
                      type="button"
                      disabled={payoutBusy !== null}
                      onClick={() => void runPayoutAction("verify", p.playerId)}
                      className="shrink-0 rounded border border-border/70 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-foreground/80 transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
                    >
                      verify
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            Prize amounts are calculated from verified payments. &quot;Pending&quot;
            means recorded and owed — payout dispatch requires the treasury
            signer and is shown separately from the prize itself.
          </p>
        </section>
      )}

      {error && <ErrorNote message={error} className="mt-6" tone="warning" />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Paid entry panel (Phase 2B)                                         */
/* ------------------------------------------------------------------ */

function totalPool(payouts: NonNullable<TournamentDetailPayload["payouts"]>): string {
  try {
    return payouts.reduce((acc, p) => acc + BigInt(p.amountLuna), 0n).toString();
  } catch {
    return "0";
  }
}

const ENTRY_PHASE_LABEL: Record<string, string> = {
  "awaiting-wallet": "Confirm in your wallet…",
  verifying: "Verifying payment on-chain…",
};

/**
 * The transaction the player sent — kept so a still-unconfirmed payment can
 * be re-verified instead of re-paid. sessionStorage deliberately: a reload
 * during the confirmation window must not orphan an on-chain payment.
 */
function readPendingTx(tournamentId: string): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(`chainmate:entry-tx:${tournamentId}`);
}

function storePendingTx(tournamentId: string, txHash: string | null) {
  if (typeof sessionStorage === "undefined") return;
  const key = `chainmate:entry-tx:${tournamentId}`;
  if (txHash) sessionStorage.setItem(key, txHash);
  else sessionStorage.removeItem(key);
}

function PaidEntryPanel({
  detail,
  entryFeeLuna,
  joined,
  paymentPending,
  entry,
  onJoined,
}: {
  detail: TournamentDetailPayload;
  entryFeeLuna: string;
  joined: boolean;
  paymentPending: boolean;
  entry: ReturnType<typeof useTournamentEntry>;
  onJoined: () => void;
}) {
  const s = detail.summary;
  const fee = displayNim(entryFeeLuna);

  // Joined + paid: quiet confirmation.
  if (joined && !paymentPending) {
    return (
      <div className="animate-fade-in-up mt-4 flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span>
          Entry paid — <strong className="font-mono tabular-nums">{fee} NIM</strong> verified on-chain.
        </span>
      </div>
    );
  }

  // Registration closed / running: no payment actions.
  if (s.status !== "registration") return null;

  const phaseLabel = ENTRY_PHASE_LABEL[entry.phase];

  return (
    <Panel className="animate-fade-in-up mt-4 [animation-delay:50ms]">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm">
            <Coins className="h-4 w-4 text-primary" aria-hidden />
            <span>
              Entry fee: <strong className="font-mono tabular-nums">{fee} NIM</strong>
              <span className="ml-2 text-2xs text-muted-foreground">
                paid to the ChainMate treasury · verified on-chain
              </span>
            </span>
          </p>
          {entry.wallet.wallet && (
            <span className="font-mono text-2xs text-muted-foreground">
              {shortNimiqAddress(entry.wallet.wallet.address)}
            </span>
          )}
        </div>

        {paymentPending && (
          <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            You&apos;re in, but the payment isn&apos;t verified yet. Complete the payment
            below before the host starts the tournament.
          </p>
        )}

        {!joined && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Joining pays the entry fee from your linked Nimiq wallet. Your seat
            is confirmed once the payment is verified on-chain.
          </p>
        )}

        {phaseLabel && (
          <p className="flex items-center gap-2 text-sm text-primary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {phaseLabel}
          </p>
        )}

        {/* Live confirmation progress while verification keeps retrying — a
            wallet-accepted payment is on-chain NOW, just not credited yet. */}
        {entry.progress && (
          <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-foreground/90">
            {entry.progress}
          </p>
        )}

        {entry.error && <ErrorNote message={entry.error} />}

        {/* Recovery path for a payment that is on-chain but not yet credited:
            re-verifies the SAME hash (server-side idempotent). Never a second
            charge — the pending hash rides in sessionStorage so a reload
            during the confirmation window does not orphan the payment. */}
        {entry.pendingTxHash && !entry.busy && (
          <div className="flex items-center gap-2.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void entry.reverify(s.id, entry.pendingTxHash ?? undefined)}
            >
              <RefreshCw aria-hidden />
              Verify payment
            </Button>
            <span className="font-mono text-2xs text-muted-foreground">
              tx {entry.pendingTxHash.slice(0, 10)}…
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!entry.wallet.wallet ? (
            <Button
              size="sm"
              disabled={
                entry.wallet.phase === "awaiting-wallet" ||
                entry.wallet.phase === "verifying"
              }
              onClick={() => {
                if (entry.wallet.provider === "available") {
                  void entry.wallet.link();
                  return;
                }
                // Not available (web-unavailable / error): re-run detection —
                // inside Nimiq Pay a second attempt often succeeds once the
                // host finished injecting the provider.
                entry.wallet.recheckProvider();
              }}
            >
              <Wallet aria-hidden />
              Connect Nimiq Wallet
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={entry.busy}
              onClick={() => {
                void entry
                  .payAndJoin(s.id, displayNim(entryFeeLuna))
                  .then(({ outcome, txHash }) => {
                    if (outcome === "error") return;
                    // Persist the hash so a reload during the confirmation
                    // window can recover it — cleared only on confirmation.
                    if (txHash) storePendingTx(s.id, txHash);
                    if (outcome === "joined") onJoined();
                  })
                  .catch(() => undefined);
              }}
            >
              {entry.busy ? <Loader2 className="animate-spin" aria-hidden /> : <Coins aria-hidden />}
              {paymentPending ? `Pay ${fee} NIM to confirm seat` : `Pay ${fee} NIM & join`}
            </Button>
          )}
          {joined && canLeaveOf(detail) && (
            <LeaveWhilePending onLeave={undefined} />
          )}
        </div>
      </div>
    </Panel>
  );
}

function canLeaveOf(detail: TournamentDetailPayload): boolean {
  return detail.myRole === "entrant" && detail.summary.status === "registration";
}

/** Minimal placeholder — leaving while payment is pending goes through Leave. */
function LeaveWhilePending({ onLeave }: { onLeave: (() => void) | undefined }) {
  return (
    <span className="text-2xs text-muted-foreground">
      Changed your mind? Use Leave above (payments already made are not refunded
      automatically).
      {onLeave ? "" : ""}
    </span>
  );
}

function PayoutStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "prize pending", cls: "border-warning/40 text-warning" },
    sent: { label: "payout sent", cls: "border-primary/40 text-primary" },
    verified: { label: "paid ✓", cls: "border-primary/40 text-primary bg-primary/5" },
    failed: { label: "failed — retrying", cls: "border-destructive/40 text-destructive" },
    blocked_no_wallet: { label: "awaiting wallet", cls: "border-warning/40 text-warning" },
  };
  const it = map[status] ?? { label: status, cls: "border-border/60 text-muted-foreground" };
  return (
    <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-2xs uppercase tracking-wider", it.cls)}>
      {it.label}
    </span>
  );
}

function PayoutStateBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    none: { label: "no payouts", cls: "text-muted-foreground" },
    pending: { label: "payouts pending", cls: "text-warning" },
    partial: { label: "payouts partially sent", cls: "text-primary" },
    paid: { label: "all payouts sent", cls: "text-primary" },
    refund_required: { label: "refund required", cls: "text-destructive" },
  };
  const it = map[status] ?? { label: status, cls: "text-muted-foreground" };
  return <span className={cn("font-semibold", it.cls)}>· {it.label}</span>;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function nameOf(detail: TournamentDetailPayload, playerId: string): string {
  // The server resolves the host's username into the summary; entrants are
  // device-local identities, so display the guest label for anyone the
  // server hasn't named (matches how Games/Watch show unnamed players).
  if (playerId === detail.summary.creatorId) return detail.summary.creatorName ?? "Host";
  return detail.entryNames?.[playerId] ?? guestDisplayName(undefined);
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** One match line — links straight to the real ChainMate game. */
function MatchRow({
  match: m,
  detail,
  me,
}: {
  match: TournamentMatch;
  detail: TournamentDetailPayload;
  me: string;
}) {
  const isMyGame = m.whitePlayerId === me || m.blackPlayerId === me;
  const resultLabel =
    m.status === "complete"
      ? m.result === "draw"
        ? "½–½"
        : m.result === "white"
          ? "1–0"
          : "0–1"
      : m.resultReason === "bye"
        ? "bye"
        : "live";
  const winnerName =
    m.result === "white"
      ? nameOf(detail, m.whitePlayerId)
      : m.result === "black"
        ? nameOf(detail, m.blackPlayerId)
        : null;

  return (
    <Link
      href={m.gameId ? `/game/${m.gameId}` : "#"}
      className={cn(
        "group flex items-center justify-between gap-3 px-4 py-2.5 transition-colors",
        m.gameId ? "hover:bg-secondary/40" : "pointer-events-none",
        isMyGame && "bg-primary/5",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className={cn(m.result === "white" && "font-semibold")}>
            {nameOf(detail, m.whitePlayerId)}
          </span>
          <span className="mx-1.5 text-muted-foreground">vs</span>
          <span className={cn(m.result === "black" && "font-semibold")}>
            {nameOf(detail, m.blackPlayerId)}
          </span>
        </p>
        {m.status === "complete" && winnerName && m.resultReason !== "bye" && (
          <p className="text-2xs text-muted-foreground">
            {winnerName} won
            {m.resultReason === "timeout" ? " on time" : m.resultReason === "resigned" ? " by resignation" : ""}
          </p>
        )}
      </div>
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 font-mono text-2xs tabular-nums",
          m.status === "complete"
            ? "border-border/60 text-muted-foreground"
            : "border-primary/40 text-primary",
        )}
      >
        {m.status !== "complete" && (
          <Radio className="mr-1 inline h-2.5 w-2.5 animate-pulse-soft" aria-hidden />
        )}
        {resultLabel}
      </span>
    </Link>
  );
}
