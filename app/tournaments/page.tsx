"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, ChevronRight, Coins, Plus, Swords, Trophy, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader, SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { tournamentApi } from "@/lib/tournament-api";
import { formatNim } from "@/lib/nimiq/format";
import type { TournamentFormat, TournamentStatus, TournamentSummary } from "@/lib/tournament-types";
import { cn } from "@/lib/utils";

/**
 * Tournaments — the list. Registration-open events first, then everything
 * running, then finished. Nothing here is a dashboard: one column, cards,
 * the four things you need to know (format, clock, who's in, what it costs).
 */

/** Exact luna string → human NIM string (client-safe display formatting). */
function formatEntryFee(luna: string): string {
  try {
    return formatNim(BigInt(luna));
  } catch {
    return luna;
  }
}

const STATUS_LABEL: Record<TournamentStatus, string> = {
  draft: "Draft",
  registration: "Open",
  locked: "Locked",
  in_progress: "Live",
  completed: "Complete",
  cancelled: "Cancelled",
};

const STATUS_STYLE: Record<TournamentStatus, string> = {
  draft: "border-border/60 text-muted-foreground",
  registration: "border-primary/40 text-primary bg-primary/5",
  locked: "border-warning/40 text-warning",
  in_progress: "border-primary/40 text-primary",
  completed: "border-border/60 text-muted-foreground",
  cancelled: "border-destructive/40 text-destructive",
};

const FORMAT_LABEL: Record<TournamentFormat, string> = {
  knockout: "Knockout",
  swiss: "Swiss",
  arena: "Arena",
};

export default function TournamentsPage() {
  const [tournaments, setTournaments] = useState<TournamentSummary[] | null>(null);
  const [players, setPlayers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await tournamentApi.list();
      setTournaments(data.tournaments);
      setPlayers(data.players);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tournaments");
      setTournaments((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const all = tournaments ?? [];
  const now = Date.now();
  // Four clean sections, newest-relevant first: what you can join, what's
  // running, what's scheduled, what's over. A tournament never appears in
  // two sections.
  const open = all.filter((t) => t.status === "registration");
  const running = all.filter((t) => t.status === "in_progress" || t.status === "locked");
  const upcoming = all.filter(
    (t) =>
      t.status === "draft" &&
      t.scheduledStartAt != null &&
      t.scheduledStartAt > now,
  );
  const past = all.filter(
    (t) =>
      !open.includes(t) &&
      !running.includes(t) &&
      !upcoming.includes(t),
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Compete"
        title="Tournaments"
        description="Join while registration is open and climb the standings."
        actions={
          <Link
            href="/tournaments/create"
            className={cn(buttonVariants({ size: "sm" }))}
          >
            <Plus aria-hidden />
            Host one
          </Link>
        }
      />

      {error && <ErrorNote message={error} className="mt-6" />}

      {tournaments === null ? (
        <Panel className="mt-8">
          <LoadingRows />
        </Panel>
      ) : tournaments.length === 0 ? (
        <Panel className="mt-8">
          <EmptyState
            icon={Trophy}
            title="No tournaments yet"
            description="Host the first one: knockout, Swiss or arena, your call."
            action={{ href: "/tournaments/create", label: "Host a tournament" }}
          />
        </Panel>
      ) : (
        <div className="mt-8 space-y-8">
          {[
            { label: "Open for registration", live: true, list: open },
            { label: "Running now", live: true, list: running },
            { label: "Upcoming", live: false, list: upcoming },
            { label: "Past", live: false, list: past },
          ]
            .filter((g) => g.list.length > 0)
            .map((group, gi) => (
              <section
                key={group.label}
                className="animate-fade-in-up"
                style={{ animationDelay: `${gi * 60}ms` }}
              >
                <SectionLabel live={group.live}>
                  {group.label}
                </SectionLabel>
                <div className="mt-3 space-y-2.5">
                  {group.list.map((t) => (
                    <TournamentCard
                      key={t.id}
                      tournament={t}
                      hostName={players[t.creatorId]}
                      winnerName={t.winnerId ? players[t.winnerId] : undefined}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}

function TournamentCard({
  tournament: t,
  hostName,
  winnerName,
}: {
  tournament: TournamentSummary;
  hostName?: string;
  winnerName?: string;
}) {
  const full = t.playerCount >= t.maxPlayers;
  return (
    <Link
      href={`/tournaments/${t.id}`}
      className={cn(
        "group block rounded-lg border bg-card/50 p-4 transition-all",
        t.status === "registration"
          ? "border-primary/25 hover:border-primary/50 hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]"
          : "border-border/70 hover:border-border hover:bg-card/80",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display truncate text-base font-semibold tracking-tight">
              {t.name}
            </h3>
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider",
                STATUS_STYLE[t.status],
              )}
            >
              {STATUS_LABEL[t.status]}
            </span>
          </div>
          {t.description && (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
              {t.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Swords className="h-3 w-3" aria-hidden />
              {FORMAT_LABEL[t.format]}
            </span>
            <span>{t.timeControl}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                full && "text-warning",
              )}
            >
              <Users className="h-3 w-3" aria-hidden />
              {t.playerCount}/{t.maxPlayers}
            </span>
            {t.entryFeeLuna && t.entryFeeLuna !== "0" ? (
              <span className="inline-flex items-center gap-1 text-foreground/80">
                <Coins className="h-3 w-3" aria-hidden />
                {formatEntryFee(t.entryFeeLuna)} NIM
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Coins className="h-3 w-3" aria-hidden />
                Free
              </span>
            )}
            {hostName && <span className="truncate">Host: {hostName}</span>}
            {/* Scheduled start: the whole point is that players show up on
                time — so the list advertises it on every pre-start card. */}
            {t.scheduledStartAt != null && t.scheduledStartAt > Date.now() &&
              (t.status === "registration" || t.status === "draft" || t.status === "locked") && (
              <span className="inline-flex items-center gap-1 text-primary">
                <CalendarClock className="h-3 w-3" aria-hidden />
                {t.status === "draft" ? "Opens" : "Starts"} {new Date(t.scheduledStartAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            {t.status === "in_progress" && t.totalRounds ? (
              <span>
                Round {t.currentRound ?? "—"}/{t.totalRounds}
              </span>
            ) : null}
            {t.status === "completed" && t.winnerId && winnerName && (
              <span className="inline-flex items-center gap-1 text-primary">
                <Trophy className="h-3 w-3" aria-hidden />
                Winner: {winnerName}
              </span>
            )}
          </div>
        </div>
        <ChevronRight
          className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden
        />
      </div>
    </Link>
  );
}
