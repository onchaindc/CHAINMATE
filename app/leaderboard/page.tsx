"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Trophy } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CountryFlag } from "@/components/ui/country-flag";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

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
      <div className="animate-fade-in-up">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Rankings
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">Leaderboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Real ELO ratings from completed online matches. Every player starts
          at 1200; every rating here came from an actual game.
        </p>
      </div>

      {error && (
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="mt-8 animate-fade-in-up [animation-delay:80ms] overflow-hidden rounded-lg border border-border/70 bg-card/50">
        {players === null ? (
          <div className="space-y-1 px-2 py-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
            ))}
          </div>
        ) : players.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Trophy className="h-8 w-8 text-muted-foreground/50" aria-hidden />
            <p className="mt-3 text-sm font-medium text-foreground/85">No rated games yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Finish an online multiplayer match and the winner&rsquo;s rating is
              updated.
            </p>
            <Link href="/create" className={cn(buttonVariants({ size: "sm" }), "mt-5")}>
              Play a rated game
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Rank</th>
                <th className="px-4 py-2.5 font-semibold">Player</th>
                <th className="px-4 py-2.5 text-right font-semibold">Rating</th>
                <th className="hidden px-4 py-2.5 text-right font-semibold sm:table-cell">Wins</th>
                <th className="hidden px-4 py-2.5 text-right font-semibold sm:table-cell">Losses</th>
                <th className="px-4 py-2.5 text-right font-semibold">Games</th>
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
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground/90">
                        <CountryFlag code={p.country} />
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
                      </span>
                      {p.isGuest && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          guest
                        </span>
                      )}
                      {isMe && (
                        <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          you
                        </span>
                      )}
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
        )}
      </div>
    </div>
  );
}
