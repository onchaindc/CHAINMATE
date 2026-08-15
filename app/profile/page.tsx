"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, User } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { mergeGamesById, cn } from "@/lib/utils";
import type { GameState, PlayerStats } from "@/lib/types";

export default function ProfilePage() {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [games, setGames] = useState<GameState[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hostedMe = useMemo(() => getStore("hosted").getMyPlayerId(), []);
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [profile, localGames] = await Promise.all([
          hosted.myProfile(),
          Promise.resolve(local.listMyGames()),
        ]);
        if (cancelled) return;
        setStats(profile.stats);
        setGames(mergeGamesById([...profile.games, ...localGames]));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load profile");
        setGames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const drawPct = stats && stats.games > 0 ? Math.round((stats.draws / stats.games) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="animate-fade-in-up flex flex-wrap items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-600 bg-zinc-800 text-zinc-100">
          <User className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Profile</h1>
          <p className="font-mono text-xs text-muted-foreground">{hostedMe}</p>
        </div>
      </div>

      {error && (
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-8 grid animate-fade-in-up grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 sm:grid-cols-5">
        {[
          { label: "Rating", value: stats ? String(stats.rating) : "—" },
          { label: "Games", value: stats ? String(stats.games) : "—" },
          { label: "Wins", value: stats ? String(stats.wins) : "—" },
          { label: "Losses", value: stats ? String(stats.losses) : "—" },
          { label: "Draws", value: stats ? `${stats.draws} (${drawPct}%)` : "—" },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-xl font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Rating updates after rated online matches between two human players.
      </p>

      {/* Recent games */}
      <div className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent games
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {games === null ? (
            <div className="space-y-1 px-2 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : games.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <p className="text-sm font-medium text-foreground/85">No games yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Play your first match to start building a record.
              </p>
              <Link href="/create" className={cn(buttonVariants({ size: "sm" }), "mt-5")}>
                Create a game
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {games.slice(0, 10).map((game) => (
                <GameRow
                  key={game.id}
                  game={game}
                  me={game.backend === "local" ? localMe : hostedMe}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
