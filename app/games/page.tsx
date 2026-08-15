"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Gamepad2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { mergeGamesById, cn } from "@/lib/utils";
import type { GameState } from "@/lib/types";

export default function GamesPage() {
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
        const [remote, localGames] = await Promise.all([
          hosted.listMine(),
          Promise.resolve(local.listMyGames()),
        ]);
        if (cancelled) return;
        setGames(mergeGamesById([...remote, ...localGames]));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load games");
        setGames([]);
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
          Your record
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">Games</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every match played from this browser, from the online store and local
          mode.
        </p>
      </div>

      <div className="mt-8 animate-fade-in-up [animation-delay:80ms] overflow-hidden rounded-lg border border-border/70 bg-card/50">
        {error && (
          <div className="flex items-start gap-2.5 border-b border-border/60 px-4 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {games === null ? (
          <div className="space-y-1 px-2 py-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
            ))}
          </div>
        ) : games.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Gamepad2 className="h-8 w-8 text-muted-foreground/50" aria-hidden />
            <p className="mt-3 text-sm font-medium text-foreground/85">No games yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Play your first match — create a game or challenge the on-device AI.
            </p>
            <Link href="/create" className={cn(buttonVariants({ size: "sm" }), "mt-5")}>
              Create a game
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-border/50 px-2 py-2">
            {games.map((game) => (
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
  );
}
