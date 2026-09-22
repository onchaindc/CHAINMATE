"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  CalendarClock,
  CheckCircle2,
  Coins,
  Crown,
  Info,
  Loader2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Swords,
  Timer,
  Trash2,
  Trophy,
  UserMinus,
  UserPlus,
  Wallet,
  XCircle,
  ExternalLink,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { BackLink, PageHeader, SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken, guestDisplayName } from "@/lib/identity";
import { tournamentApi, type TournamentDetailPayload, type TournamentAction } from "@/lib/tournament-api";
import { clearPendingEntryTx, loadPendingEntryTx } from "@/lib/nimiq/pending-entry-tx";
import type { TournamentFormat, TournamentMatch, TournamentStatus } from "@/lib/tournament-types";
import { formatNim } from "@/lib/nimiq/format";
import { isNimiqEnabled } from "@/lib/nimiq/flag";
import { nimiqPayDeepLinks } from "@/lib/nimiq/deep-link";
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
  draft: "Draft: not open yet",
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
  const router = useRouter();
  const id = typeof params.id === "string" ? params.id : "";
  const identity = useIdentity();

  const [detail, setDetail] = useState<TournamentDetailPayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<TournamentAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Set while the self-serve prize-address save is in flight. */
  const [payoutBusy, setPayoutBusy] = useState<string | null>(null);
  /** Leave confirmation (paid events warn about forfeiting the entry). */
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** Delete confirmation (host, or admin on any event). */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Is the viewer a ChainMate admin (admin dashboard exists separately)? */
  const [isAdmin, setIsAdmin] = useState(false);

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

  // Admin flag: only read once identity settles. Failure means "not admin"
  // (the endpoint 404s for non-admins by design).
  useEffect(() => {
    if (identity.status === "loading" || !identity.playerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = getIdentityToken();
        const res = await fetch(
          `/api/admin/whoami?playerId=${encodeURIComponent(identity.playerId)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
        );
        if (!res.ok) {
          if (!cancelled) setIsAdmin(false);
          return;
        }
        const data = (await res.json()) as { admin?: boolean };
        if (!cancelled) setIsAdmin(data.admin === true);
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.status, identity.playerId]);

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

  /** Leave, after the confirm dialog has been accepted. */
  const leaveNow = async () => {
    setConfirmLeave(false);
    await act("leave");
  };

  // Hooks before any early return (rules-of-hooks): the paid-entry flow is
  // only USED for paid tournaments, but it is always INSTANTIATED.
  const entry = useTournamentEntry(identity.playerId);
  /** Reload recovery armed until the first detail load decides on it. */
  const [resumeChecked, setResumeChecked] = useState(false);
  /**
   * A payment that JUST verified on-chain. Showed as a full confirmation
   * banner (not the quiet one-liner) so the moment the money leaves the
   * wallet the player sees unmistakably that the seat was bought — no more
   * “did I just get robbed?” after a successful payment.
   */
  const [justConfirmed, setJustConfirmed] = useState(false);
  /**
   * A payment of this player's is on-chain but currently has NO seat: they
   * left while it was pending, or verification failed and the (unpaid) seat
   * was released. The NIM is NOT lost to the app — it sits in the treasury
   * on-chain — but it is also not automatically refunded, so the banner
   * says exactly that instead of implying anything happened that didn't.
   */
  const [pendingRejoin, setPendingRejoin] = useState(false);

  // The confirmation moment: the entry flips to paid (the refresh after
  // onJoined lands it). Fires only on the false→paid TRANSITION — a player
  // reloading a tournament they already paid for must not get the receipt
  // banner again.
  const confirmedPaid =
    !!detail &&
    detail.myRole === "entrant" &&
    detail.summary.status === "registration" &&
    detail.entries.some((e) => e.playerId === identity.playerId && e.paid);
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrate = useCallback(() => {
    setJustConfirmed(true);
    if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
    celebrateTimer.current = setTimeout(() => setJustConfirmed(false), 12000);
  }, []);
  const prevPaidRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevPaidRef.current;
    prevPaidRef.current = confirmedPaid;
    if (confirmedPaid && prev === false) celebrate();
  }, [confirmedPaid, celebrate]);
  // Leaving with an unverified payment: keep the tx hash so it can still be
  // verified (and shown) — the payment itself is not undone by leaving.
  const stillJoined = detail?.myRole === "entrant";
  useEffect(() => {
    if (!stillJoined) {
      if (entry.pendingTxHash) setPendingRejoin(true);
      else setPendingRejoin(false);
    } else {
      setPendingRejoin(false); // back in — the normal entry UI takes over
    }
  }, [stillJoined, entry.pendingTxHash]);

  /**
   * Reload recovery: if the player paid (a pending tx is stored) but left
   * during the confirmation window, resume verification for the SAME hash —
   * never a second payment. Runs once, after the first detail load tells us
   * whether the seat is still unpaid.
   */
  useEffect(() => {
    if (!detail || resumeChecked || !identity.playerId) return;
    setResumeChecked(true);
    const stored = loadPendingEntryTx(id, identity.playerId);
    if (!stored) return;
    const myEntry = detail.entries.find((e) => e.playerId === identity.playerId);
    // Recover whenever this paid tournament could still credit the payment:
    // registration open and the player's seat (if any) is unpaid. myRole is
    // deliberately NOT required to be "entrant" — before verification there
    // is no seat at all, and requiring it wiped the stored hash (the bug that
    // orphaned payments on refresh).
    const canStillCredit =
      detail.summary.entryFeeLuna != null &&
      detail.summary.entryFeeLuna !== "0" &&
      !myEntry?.paid &&
      detail.summary.status === "registration";
    if (canStillCredit) {
      entry.setPendingTxHash(stored);
      void entry.reverify(id, stored);
    } else {
      clearPendingEntryTx(id, identity.playerId); // credited or no longer creditable
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, resumeChecked, identity.playerId]);

  /**
   * One quiet host-side heal: for every unfinished prize, ask the server to
   * resolve the row to its true state — it discovers a payment the host
   * already sent (the legacy "sending… forever" rows) and settles it with
   * full on-chain identity gates, or advances confirmations. Runs once per
   * load while something is still owed; never sends, never pays twice.
   */
  /** Quiet status refresh for ADMIN viewers: for every unsettled prize,
      ask the server to resolve the row to its true state — it discovers a
      payment the operator already sent and settles it with full on-chain
      identity gates, or advances confirmations. Admin-only now (ChainMate
      disburses); a host viewer simply skips this. Runs once per load while
      something is still owed; never sends, never pays twice. */
  const prizeHealRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !detail ||
      !isAdmin ||
      !detail.payouts?.length ||
      !identity.playerId
    ) {
      return;
    }
    const owed = detail.payouts.filter((p) => p.status !== "verified");
    if (owed.length === 0) return;
    const key = `${id}:${owed.map((p) => p.playerId + p.status).join("|")}`;
    if (prizeHealRef.current === key) return;
    prizeHealRef.current = key;
    void (async () => {
      for (const p of owed) {
        try {
          await tournamentApi.payoutAction(id, identity.playerId, "wallet-confirm", p.playerId);
        } catch {
          /* nothing to settle yet; the buttons and the next load still cover it */
        }
      }
      await load();
    })();
  }, [detail, isAdmin, identity.playerId, id, load]);

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
  // Membership, not role: a HOST WHO JOINED (the common paid-event case —
  // hosts must pay like everyone else) used to see the Pay button forever
  // with a "Payment confirmed" banner, because myRole stays "host" after
  // joining. Being among the active entries is what "joined" means.
  const joined =
    isEntrant || detail.entries.some((e) => e.playerId === identity.playerId);
  const entryFeeLuna = s.entryFeeLuna && s.entryFeeLuna !== "0" ? s.entryFeeLuna : null;
  const isPaid = entryFeeLuna !== null;
  // Guests are barred from tournament participation server-side (hosting and
  // joining alike); the UI mirrors that with sign-up CTAs instead of dead
  // buttons that only error on click.
  const isGuest = identity.isGuest;
  const myEntry = detail.entries.find((e) => e.playerId === identity.playerId);
  const myPaymentPending = isPaid && joined && !myEntry?.paid && s.status === "registration";
  const canJoin =
    s.status === "registration" && !joined && s.playerCount < s.maxPlayers;
  const canLeave = s.status === "registration" && joined && !entry.busy;
  const full = s.playerCount >= s.maxPlayers;
  const scheduled = s.scheduledStartAt ?? null;
  const scheduledFuture = scheduled != null && scheduled > Date.now();
  const canDelete =
    isHost && (s.status === "draft" || s.status === "registration");
  /**
   * Delete is admin-only once a THIRD PARTY has a verified paid seat: those
   * entries are real funds. The host keeps the button only while nobody but
   * they (or nobody at all) has paid. The server enforces the same rule.
   */
  const thirdPartyPaid =
    isPaid &&
    detail.entries.some(
      (e) => e.paid && e.playerId !== s.creatorId && e.playerId !== identity.playerId,
    );
  const showDelete = canDelete && !(thirdPartyPaid && !isAdmin);
  const showStandings =
    s.status === "in_progress" || s.status === "completed" || detail.standings.some((r) => r.played > 0);
  const winnerRow = detail.standings.find((r) => r.playerId === s.winnerId);

  /** Host (or admin) delete: confirm, then remove and go back to the list. */
  const deleteTournament = async () => {
    setConfirmDelete(false);
    setBusy("delete");
    setActionError(null);
    try {
      await tournamentApi.action(id, identity.playerId, "delete");
      router.push("/tournaments");
    } catch (err) {
      setActionError(friendlyError(err));
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <BackLink href="/tournaments" className="mb-4">
        Back to tournaments
      </BackLink>
      {/* ---------- Header ---------- */}
      <PageHeader
        eyebrow={FORMAT_LABEL[s.format]}
        title={s.name}
        description={s.description || undefined}
        actions={
          <div className="flex items-center gap-2">
            {canJoin && !isPaid && !isGuest && (
              <Button size="sm" disabled={busy !== null} onClick={() => void act("join")}>
                {busy === "join" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <UserPlus aria-hidden />
                )}
                Join
              </Button>
            )}
            {canLeave && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  if (isPaid) setConfirmLeave(true);
                  else void act("leave");
                }}
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
            {/* No "Resume game" here: the live match banner below IS the
                one clear way into an active game — a second button saying
                the same thing read as a stuck/lagging state. */}
          </div>
        }
      />

      {/* ---------- YOUR MATCH IS LIVE — play now ---------- */}
      {detail.myActiveGameId && s.status === "in_progress" && (
        <Link
          href={`/game/${detail.myActiveGameId}`}
          className="animate-fade-in-up group mt-4 flex items-center gap-3 rounded-lg border border-primary/50 bg-primary/10 px-4 py-3.5 transition-colors hover:bg-primary/15"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" aria-hidden />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-primary">Your match is live — play now</p>
            <p className="text-xs text-muted-foreground">
              Round {s.currentRound ?? "—"} is underway. Your opponent is waiting at the board.
            </p>
          </div>
          <span className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-transform group-hover:translate-x-0.5">
            Go to board →
          </span>
        </Link>
      )}

      {/* ---------- ROUND ENDED — intermission before the next one ---------- */}
      {s.status === "in_progress" &&
        s.nextRoundAt != null &&
        s.nextRoundAt > Date.now() && (
        <div
          className="animate-fade-in-up mt-4 flex items-center gap-3 rounded-lg border border-border/70 bg-card/50 px-4 py-3.5"
          role="status"
        >
          <Timer className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              Round {s.currentRound ?? "—"} has ended
            </p>
            <p className="text-xs text-muted-foreground">
              Standings are updated. Round {s.currentRound != null ? s.currentRound + 1 : "—"} starts
              in <IntermissionCountdown at={s.nextRoundAt} /> — the page updates by itself.
            </p>
          </div>
        </div>
      )}

      {/* ---------- Facts strip ---------- */}
      <div className="animate-fade-in-up mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-xs tabular-nums text-muted-foreground [animation-delay:40ms]">
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
        {scheduledFuture && (s.status === "draft" || s.status === "registration") && (
          <span className="inline-flex items-center gap-1 font-sans text-2xs font-semibold uppercase tracking-wider text-primary">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            {s.status === "draft" ? "Opens" : "Starts"} {new Date(scheduled).toLocaleString()}
          </span>
        )}
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

      {/* ---------- Cancelled state: reason + refund progress ---------- */}
      {s.status === "cancelled" && (
        <div
          className="animate-fade-in-up mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3.5"
          role="status"
        >
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-destructive">Tournament cancelled</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                {s.cancelReason
                  ? s.cancelReason
                  : "The host cancelled this tournament before it started."}
              </p>
              {detail.refunds && detail.refunds.length > 0 && (
                <div className="mt-3">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Entry fee refunds
                  </p>
                  <ul className="mt-1.5 divide-y divide-border/40 rounded-md border border-border/50">
                    {detail.refunds.map((r) => (
                      <li key={r.playerId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{nameOf(detail, r.playerId)}</span>
                        <span className="font-mono text-xs tabular-nums text-foreground/80">
                          {displayNim(r.amountLuna)} NIM
                        </span>
                        <span
                          className={cn(
                            "text-2xs font-semibold uppercase tracking-wider",
                            r.status === "verified" && "text-positive",
                            r.status === "dispatched" && "text-primary",
                            (r.status === "owed" || r.status === "failed") && "text-warning",
                          )}
                        >
                          {r.status === "owed" && "refund queued"}
                          {r.status === "dispatched" && "returning"}
                          {r.status === "verified" && "refunded"}
                          {r.status === "failed" && "retrying"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- Outstanding refunds on LIVE/finished events ---------- */}
      {/* A refund obligation can exist on a COMPLETED event too: a player
          left during registration and their verified fee was queued for
          return, then the event played out. The cancelled banner above only
          renders for cancelled events — without this block the completed
          event showed the "refund required" aggregate with NOTHING to look
          at or settle. Same list, same actions, no red banner. */}
      {s.status !== "cancelled" && detail.refunds && detail.refunds.length > 0 && (
        <section className="animate-fade-in-up mt-8">
          <SectionLabel>Entry fee refunds</SectionLabel>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            Fees queued for return from players who left before the event
            locked. Prizes and refunds settle independently.
          </p>
          <Panel className="mt-3">
            <ul className="divide-y divide-border/50">
              {detail.refunds.map((r) => (
                <li key={r.playerId} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(detail, r.playerId)}
                    {r.playerId === identity.playerId && (
                      <span className="ml-1.5 text-2xs uppercase tracking-wider text-primary">you</span>
                    )}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-foreground/80">
                    {displayNim(r.amountLuna)} NIM
                  </span>
                  <span
                    className={cn(
                      "text-2xs font-semibold uppercase tracking-wider",
                      r.status === "verified" && "text-positive",
                      r.status === "dispatched" && "text-primary",
                      (r.status === "owed" || r.status === "failed") && "text-warning",
                    )}
                  >
                    {r.status === "owed" && "refund queued"}
                    {r.status === "dispatched" && "returning"}
                    {r.status === "verified" && "refunded"}
                    {r.status === "failed" && "retrying"}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      )}

      {/* An auto-dispatch note is guidance, not a failure: this deployment
          pays prizes from the host wallet by design, so it gets a quiet
          one-liner in the notice tone instead of a red alarm box. */}
      {actionError &&
        (actionError.includes("can't sign transactions") ? (
          <p className="mt-4 flex items-center gap-2 rounded-md bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            This deployment pays prizes from the host wallet — use the buttons under each prize.
          </p>
        ) : (
          <ErrorNote message={actionError} className="mt-4" />
        ))}

      {/* ---------- Payment confirmation (the receipt). One line, said once:
          the headline and the amount. No repeated sentence under it. ---------- */}
      {isPaid && (justConfirmed || pendingRejoin) && (
        <div
          role="status"
          className={cn(
            "animate-fade-in-up mt-3 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-semibold tracking-tight",
            pendingRejoin ? "bg-warning/10 text-warning"            : "bg-destructive/10 text-destructive",
          )}
        >
          {pendingRejoin ? (
            <Coins className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          )}
          {pendingRejoin ? (
            <span>
              Payment seen — not credited yet. Verify it below; you won&rsquo;t be charged again.
            </span>
          ) : (
            <span>
              Payment confirmed — you&rsquo;re in
              <span className="ml-2 font-mono font-semibold tabular-nums text-foreground/80">
                {displayNim(entryFeeLuna)} NIM
              </span>
            </span>
          )}
        </div>
      )}

      {/* ---------- Guest gate ---------- */}
      {isGuest && !joined && (s.status === "registration" || s.status === "draft") && (
        <div className="animate-fade-in-up mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
          <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">
            Tournaments need a ChainMate account — standings are a permanent
            ranked record. Guest play stays unlimited in casual games.
          </span>
          <Link
            href="/auth?upgrade=1"
            className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline-offset-2 hover:underline"
          >
            Create free account
          </Link>
        </div>
      )}

      {/* ---------- Paid entry panel (Phase 2B) ---------- */}
      {isPaid && isNimiqEnabled() && !isGuest && (
        <PaidEntryPanel
          detail={detail}
          entryFeeLuna={entryFeeLuna!}
          joined={joined}
          paymentPending={myPaymentPending}
          entry={entry}
          celebrating={justConfirmed}
          onJoined={() => {
            // The hook already cleared the durable pending-payment record the
            // moment verification succeeded — nothing to wipe here.
            celebrate(); // the receipt — the load() below flips the data to paid
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
            {canDelete && !showDelete && (
              <span
                className="text-2xs text-muted-foreground"
                title="A player has paid to enter. Only a ChainMate administrator can delete a tournament with paid entries."
              >
                Paid entries locked
              </span>
            )}
            {showDelete && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => setConfirmDelete(true)}
                title="Remove this tournament entirely"
              >
                {busy === "delete" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Trash2 aria-hidden />
                )}
                Delete
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
                <p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {round.label}
                  {!round.open && (
                    <span className="rounded bg-secondary/60 px-1.5 py-0.5 font-sans text-2xs tracking-normal text-muted-foreground">
                      ended
                    </span>
                  )}
                  {round.open && s.status === "in_progress" && (
                    <span className="inline-flex items-center gap-1 font-sans text-2xs tracking-normal text-primary">
                      <Radio className="h-2.5 w-2.5 animate-pulse-soft" aria-hidden /> live
                    </span>
                  )}
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
            Find an opponent above whenever you&rsquo;re free. One active game at a
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

      {/* ---------- Standings — the live tournament leaderboard. Visible as
          soon as the event goes live and until it is concluded (and after). */}
      {showStandings && (
        <section className="animate-fade-in-up mt-8 [animation-delay:120ms]">
          <SectionLabel live={s.status === "in_progress"}>
            {s.status === "completed" ? "Final standings" : "Leaderboard"}
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
                    : "Be the first: hit Join."
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
                    {e.withdrawnAt ? (
                      <span className="text-2xs uppercase tracking-wider text-negative">withdrawn</span>
                    ) : e.paid ? (
                      <span className="inline-flex items-center gap-1 text-2xs uppercase tracking-wider text-positive">
                        <ShieldCheck className="h-3 w-3" aria-hidden /> paid
                      </span>
                    ) : isPaid ? (
                      <span className="text-2xs uppercase tracking-wider text-warning">payment required</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      )}

      {/* ---------- Pool & payouts (completed paid tournaments) ---------- */}
      {isPaid && detail.payouts && detail.payouts.length > 0 && (
        <section className="animate-fade-in-up mt-8 [animation-delay:140ms]">
          <SectionLabel>Pool &amp; payouts</SectionLabel>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs leading-relaxed text-muted-foreground">
            <span>
              Prize pool: <strong className="font-mono tabular-nums text-foreground">{displayNim(detail.verifiedPoolLuna ?? totalPool(detail.payouts))} NIM</strong>
              {" "}from verified entries ({s.prizePreset === "top3" ? "60/25/15" : s.prizePreset === "top5" ? "45/25/15/10/5" : "winner takes all"})
            </span>
            <PayoutStateBadge status={s.payoutStatus ?? "none"} />
          </p>
          <Panel className="mt-3">
            <ul className="divide-y divide-border/50">
              {detail.payouts.map((p) => (
                <li key={p.playerId} className="flex flex-wrap items-center gap-3 px-4 py-2">
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
                  {/* A winner whose wallet cannot be resolved points at the
                      address their own prize should go to. Everything else
                      about the payout stays in the admin console. */}
                  {p.playerId === identity.playerId &&
                    (p.status === "blocked_no_wallet" || p.status === "pending" || p.status === "failed") && (
                      <MyDestinationEditor
                        tournamentId={id}
                        myPlayerId={identity.playerId}
                        disabled={payoutBusy !== null}
                        onSaved={() => void load()}
                      />
                    )}
                </li>
              ))}
            </ul>
          </Panel>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            &quot;Pending&quot; = owed. If a send was interrupted,
            &quot;Check status&quot; resolves it safely — it can never pay twice.
          </p>
        </section>
      )}

      {error && <ErrorNote message={error} className="mt-6" tone="warning" />}

      {/* ---------- Leave confirmation (paid events) ---------- */}
      <ConfirmDialog
        open={confirmLeave}
        title={`Leave ${s.name}?`}
        destructive
        busy={busy === "leave"}
        confirmLabel="Leave and forfeit"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => void leaveNow()}
      >
        {isPaid ? (
          <>
            <p>
              This is a paid tournament. Leaving now forfeits your entry fee of{" "}
              <strong className="font-mono tabular-nums text-foreground">
                {displayNim(entryFeeLuna)} NIM
              </strong>{" "}
              and it is not refunded.
            </p>
            {myEntry?.paid ? (
              <p className="mt-2">
                Your payment has been verified, so your fee is already in the
                prize pool. Leaving removes your seat and your chance at the
                prizes, but does not return the NIM.
              </p>
            ) : (
              <p className="mt-2">
                Your payment is not verified yet; if it lands after you leave
                it will sit uncredited in the treasury until support resolves
                it.
              </p>
            )}
          </>
        ) : (
          <p>Leave this tournament? You can rejoin while registration is open.</p>
        )}
      </ConfirmDialog>

      {/* ---------- Delete confirmation ---------- */}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this tournament?"
        destructive
        busy={busy === "delete"}
        confirmLabel="Delete permanently"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void deleteTournament()}
      >
        <p>
          Players who joined will see it is gone. This cannot be undone.
          {thirdPartyPaid &&
            " A player has already paid to enter, so the record of this event must stay with the administrator who deletes it."}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Paid entry panel (Phase 2B)                                         */
/* ------------------------------------------------------------------ */

/**
 * SELF-SERVE PRIZE ADDRESS. A winner with no linked Nimiq wallet (or whose
 * binding cannot be resolved) types the address their own prize should go
 * to; the admin console unblocks and sends. Strictly one's own prize — the
 * server rejects any other target, and the send itself remains ChainMate's
 * job, so this input moves no money.
 */
function MyDestinationEditor({
  tournamentId,
  myPlayerId,
  disabled,
  onSaved,
}: {
  tournamentId: string;
  myPlayerId: string;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        className="shrink-0 rounded border border-primary/50 bg-primary/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
      >
        add payout address
      </button>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await tournamentApi.setMyPrizeDestination(tournamentId, myPlayerId, value.trim());
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the address");
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="flex w-full flex-col gap-1.5 sm:w-auto">
      <span className="flex gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="NQ… address"
          autoFocus
          className="min-w-0 flex-1 rounded border border-border/70 bg-background px-2 py-1 font-mono text-2xs outline-none transition-colors focus:border-primary/50 sm:w-56"
        />
        <button
          type="button"
          disabled={saving || disabled || !value.trim()}
          onClick={() => void save()}
          className="shrink-0 rounded border border-primary/50 bg-primary/10 px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
        >
          {saving ? "saving…" : "save"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="shrink-0 rounded px-1.5 py-1 text-2xs text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </span>
      {error && <span className="text-2xs text-destructive">{error}</span>}
    </span>
  );
}

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

function PaidEntryPanel({
  detail,
  entryFeeLuna,
  joined,
  paymentPending,
  entry,
  celebrating,
  onJoined,
}: {
  detail: TournamentDetailPayload;
  entryFeeLuna: string;
  joined: boolean;
  paymentPending: boolean;
  entry: ReturnType<typeof useTournamentEntry>;
  /** A payment JUST verified — the big receipt banner above owns the moment. */
  celebrating: boolean;
  onJoined: () => void;
}) {
  const s = detail.summary;
  const fee = displayNim(entryFeeLuna);

  // Joined + paid: quiet confirmation. While the celebratory receipt banner
  // is up this stays silent — one clear confirmation beats two at once.
  if (joined && !paymentPending) {
    if (celebrating) return null;
    return (
      <div className="animate-fade-in-up mt-4 flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span>
          Entry paid: <strong className="font-mono tabular-nums">{fee} NIM</strong>
        </span>
      </div>
    );
  }

  // Registration closed / running: no payment actions.
  if (s.status !== "registration") return null;

  const phaseLabel = ENTRY_PHASE_LABEL[entry.phase];
  // A sent-but-uncredited payment owns the panel: verifying it is the only
  // sane action, so the Pay button stays hidden — this is the end of the
  // "I kept paying and paying" loop.
  const uncredited = entry.pendingTxHash !== null;

  return (
    <Panel className="animate-fade-in-up mt-4 [animation-delay:50ms]">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm">
            <Coins className="h-4 w-4 text-primary" aria-hidden />
            <span>
              Entry fee: <strong className="font-mono tabular-nums">{fee} NIM</strong>
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
            You&apos;re in, but the payment isn&apos;t confirmed yet. Complete the payment
            below before the host starts the tournament.
          </p>
        )}

        {!joined && (
          <p className="text-xs text-muted-foreground">
            Joining pays {fee} NIM from your linked Nimiq wallet.
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
            charge. The pending hash rides in localStorage (survives reloads
            and closed tabs) so the confirmation window never orphans a
            payment. */}
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
            entry.wallet.provider === "available" ? (
              <Button
                size="sm"
                disabled={
                  entry.wallet.phase === "awaiting-wallet" ||
                  entry.wallet.phase === "verifying"
                }
                onClick={() => void entry.wallet.link()}
              >
                <Wallet aria-hidden />
                Connect Nimiq Wallet
              </Button>
            ) : (
              /* Outside Nimiq Pay (normal browser) the provider can never
                 inject, so a Connect button here is a dead end. Deep-link
                 into Nimiq Pay instead: it opens THIS page inside the wallet. */
              <a
                href={nimiqPayDeepLinks()?.https ?? "#"}
                className={buttonVariants({ size: "sm" })}
              >
                <ExternalLink aria-hidden />
                Open in Nimiq Pay
              </a>
            )
          ) : uncredited ? (
            // A payment is on-chain and uncredited: paying again is how the
            // "endless paying loop" burned funds. Only Verify (above) and —
            // after a TERMINAL failure — the explicit dismiss below exist.
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                entry.clearPending(s.id); // drops the durable record too
              }}
            >
              Dismiss this payment
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={entry.busy}
              onClick={() => {
                void entry
                  .payAndJoin(s.id, displayNim(entryFeeLuna))
                  .then(({ outcome }) => {
                    // The hash was already persisted durably at send time by
                    // the hook — a reload mid-confirmation-window recovers it.
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
  /* Quiet tinted chips, sentence case — a status is a fact, not a shout. */
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "pending", cls: "bg-warning/10 text-warning" },
    dispatching: { label: "sending…", cls: "bg-warning/10 text-warning" },
    sent: { label: "confirming…", cls: "bg-primary/10 text-primary" },
    verified: { label: "paid", cls: "bg-primary/10 text-primary" },
    failed: { label: "retrying", cls: "bg-destructive/10 text-destructive" },
    blocked_no_wallet: { label: "needs wallet", cls: "bg-warning/10 text-warning" },
  };
  const it = map[status] ?? { label: status, cls: "bg-secondary/50 text-muted-foreground" };
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium", it.cls)}>
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

/**
 * Live countdown to a scheduled instant ("45s", "1m 20s"). Re-renders on the
 * page's own 5s poll cadence — good enough for a one-minute intermission.
 */
function IntermissionCountdown({ at }: { at: number }) {
  const remaining = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  if (remaining <= 0) return <strong className="font-mono tabular-nums">any second now</strong>;
  if (remaining < 60) {
    return <strong className="font-mono tabular-nums">{remaining}s</strong>;
  }
  return (
    <strong className="font-mono tabular-nums">
      {Math.floor(remaining / 60)}m {remaining % 60}s
    </strong>
  );
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
        "group flex items-center justify-between gap-3 px-4 py-2 transition-colors",
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
          "shrink-0 rounded-full px-2 py-0.5 font-mono text-2xs uppercase tracking-wider tabular-nums",
          m.status === "complete"
            ? "bg-secondary/50 text-muted-foreground"
            : "bg-destructive/10 text-destructive",
        )}
      >
        {m.status !== "complete" ? (
          <span className="inline-flex items-center">
            <span
              className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-destructive align-middle"
              aria-hidden
            />
            live
          </span>
        ) : (
          resultLabel
        )}
      </span>
    </Link>
  );
}
