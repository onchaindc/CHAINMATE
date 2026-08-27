"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { CountryFlag } from "@/components/ui/country-flag";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { guestDisplayName } from "@/lib/identity";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A header cell.
 *
 * **Deliberately not sticky.** It used to be `sticky top-nav z-10`, and that is
 * what put the header on top of the first player instead of above it. A sticky
 * box resolves its offsets against its nearest *scrolling* ancestor, and the
 * horizontal scroller this table needs is one — unavoidably. CSS does not allow
 * a one-axis scroll container: when `overflow-x` is `auto`, an `overflow-y` of
 * `visible` computes to `auto` too, so `overflow-x-auto overflow-y-visible`
 * scrolls on **both** axes no matter what it asks for.
 *
 * So `top-nav` never meant "pin under the nav" here. It resolved against a box
 * that never scrolls vertically, which left the header nothing to stick to and
 * only a 3.5rem offset to honour — shifting it down over row 1. It was never
 * sticking; it was only ever overlapping. A sticky header and a horizontal
 * scroller are mutually exclusive, and the scroller is the one keeping the last
 * column from being cut off.
 *
 * `shadow` for the underline, not `border-b` — with `border-collapse: collapse`
 * (Tailwind's preflight default) borders belong to the table, not the cell, so a
 * bottom border on a header cell is drawn by the table and can land a hair off
 * the row it belongs to. A shadow is painted by the cell itself.
 */
const HEAD =
  "bg-card px-4 py-2.5 font-semibold shadow-[inset_0_-1px_0_0_hsl(var(--border))]";

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
        description="Rated games only. Ratings update after each result."
      />

      {error && <ErrorNote message={error} className="mt-6" />}

      {/* Clips again now that nothing inside is sticky — `clip={false}` was only
          ever there to keep this panel from becoming the sticky header's
          scrolling ancestor, and the header it was protecting is gone. Clipping
          means the corner cells no longer have to round themselves. */}
      <Panel className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        {players === null ? (
          <LoadingRows />
        ) : players.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="No rated games yet"
            description="Play a rated game to appear here."
            action={{ href: "/create", label: "Play a rated game" }}
          />
        ) : (
          /* Horizontal escape hatch for the narrow end of the range. This scrolls
             on both axes whichever way it's written (see `HEAD`), so nothing
             inside it can be sticky. */
          <div className="overflow-x-auto">
            {/* Column widths have to clear the *header* labels, not the digits.
                The labels are the widest thing in these columns — uppercase
                `text-2xs` with `tracking-wider` — and `px-4` eats 2rem of every
                column before any text is drawn. At `w-16` that left a 32px
                content box, which "LOSSES" (~44px) and "GAMES" (~41px) cannot
                fit; table cells don't clip and a single word can't wrap, so they
                spilled into the neighbouring column and the last one read as
                cut off. Sized off the labels now. */}
            <table className="w-full min-w-[26rem] table-fixed text-sm">
              <thead>
                <tr className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className={cn(HEAD, "w-12 text-right")}>#</th>
                  <th className={cn(HEAD, "text-left")}>Player</th>
                  <th className={cn(HEAD, "w-24 text-right")}>Rating</th>
                  <th className={cn(HEAD, "hidden w-20 text-right sm:table-cell")}>Wins</th>
                  <th className={cn(HEAD, "hidden w-24 text-right sm:table-cell")}>Losses</th>
                  <th className={cn(HEAD, "w-20 text-right")}>Games</th>
                </tr>
              </thead>
              <tbody>
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
                              {guestDisplayName(p.username)}
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
