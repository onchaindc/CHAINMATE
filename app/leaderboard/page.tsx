"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { CountryFlag } from "@/components/ui/country-flag";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A sticky header cell.
 *
 * Three things it has to get right, all of them non-obvious:
 *
 * `top-nav` — the nav is fixed and opaque, so a header stuck to `top-0` parks
 * behind it. This is the nav's own height token.
 *
 * The opaque background — the panel's `bg-card/50` is translucent, and rows
 * would scroll visibly through a header that inherited it. `bg-card` matches
 * the panel's own surface once composited over the page, so the header looks
 * like part of the panel rather than a strip of a different colour.
 *
 * `shadow` for the underline, not `border-b` — with `border-collapse: collapse`
 * (Tailwind's preflight default) borders belong to the table, not the cell, so a
 * bottom border stays with the row's original position and slides out from under
 * the header as it sticks. A shadow is painted by the cell and travels with it.
 */
const HEAD =
  "sticky top-nav z-10 bg-card px-4 py-2.5 font-semibold shadow-[inset_0_-1px_0_0_hsl(var(--border))]";

export default function LeaderboardPage() {
  const identity = useIdentity();
  const [players, setPlayers] = useState<PlayerStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = identity.playerId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await (getStore("hosted") as HostedGameStore).leaderboard();
        if (!cancelled) setPlayers(list);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load leaderboard");
          setPlayers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Rankings"
        title="Leaderboard"
        description="Real ELO ratings from completed online matches. Every player starts at 1200; every rating here came from an actual game."
      />

      {error && <ErrorNote message={error} className="mt-6" />}

      {/* `clip={false}`, because the sticky header below resolves against the
          nearest scrolling ancestor — and `overflow-hidden` would make this
          panel one, pinning the header to a box that never scrolls. */}
      <Panel clip={false} className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        {players === null ? (
          <LoadingRows />
        ) : players.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="No rated games yet"
            description="Finish an online multiplayer match and the winner’s rating is updated."
            action={{ href: "/create", label: "Play a rated game" }}
          />
        ) : (
          /* `overflow-x-auto` on a wrapper *inside* the panel, not on the panel:
             a horizontal scroller is also the nearest scrolling ancestor for
             `position: sticky`, and the header needs to resolve against the page.
             `overflow-y-visible` keeps this box from capturing the vertical axis
             — a scroll container clips on both, even when only one can scroll. */
          <div className="overflow-x-auto overflow-y-visible">
            <table className="w-full min-w-[26rem] table-fixed text-sm">
              <thead>
                <tr className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className={cn(HEAD, "w-12 rounded-tl-lg text-right")}>#</th>
                  <th className={cn(HEAD, "text-left")}>Player</th>
                  <th className={cn(HEAD, "w-20 text-right")}>Rating</th>
                  <th className={cn(HEAD, "hidden w-16 text-right sm:table-cell")}>Wins</th>
                  <th className={cn(HEAD, "hidden w-16 text-right sm:table-cell")}>Losses</th>
                  <th className={cn(HEAD, "w-16 rounded-tr-lg text-right")}>Games</th>
                </tr>
              </thead>
              {/* The panel can't clip (see above), so the corner cells round
                  themselves — otherwise the header's opaque fill and a
                  highlighted bottom row paint square corners over the panel's
                  rounded border. */}
              <tbody className="[&>tr:last-child>td:first-child]:rounded-bl-lg [&>tr:last-child>td:last-child]:rounded-br-lg">
                {players.map((p, i) => {
                  const isMe = p.playerId === me;
                  return (
                    <tr
                      key={p.playerId}
                      className={cn(
                        "border-b border-border/40 last:border-0",
                        isMe && "bg-primary/5",
                      )}
                    >
                      {/* Right-aligned so the ranks form a column at the point
                          where they change width — 9 and 10 lined up on the
                          wrong edge when this was left-aligned. */}
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5">
                        {/* The badges are inside the flex, not siblings after it:
                            as siblings they sat outside the row's alignment and
                            `truncate` on a long name pushed them onto a second
                            line, so a guest's pill could land under their name. */}
                        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground/90">
                          <CountryFlag code={p.country} className="shrink-0" />
                          {!p.isGuest && p.username ? (
                            <Link
                              href={`/players/${encodeURIComponent(p.username)}`}
                              className="truncate underline-offset-2 hover:underline"
                            >
                              {p.username}
                            </Link>
                          ) : (
                            <span className="truncate">
                              {p.username ?? `Guest_${p.playerId.slice(0, 4).toUpperCase()}`}
                            </span>
                          )}
                          {p.isGuest && (
                            <span className="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground">
                              guest
                            </span>
                          )}
                          {isMe && (
                            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-primary">
                              you
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold tabular-nums text-primary">
                        {p.rating}
                      </td>
                      <td className="hidden px-4 py-2.5 text-right font-mono text-xs tabular-nums text-foreground/80 sm:table-cell">
                        {p.wins}
                      </td>
                      <td className="hidden px-4 py-2.5 text-right font-mono text-xs tabular-nums text-foreground/80 sm:table-cell">
                        {p.losses}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {p.games}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
