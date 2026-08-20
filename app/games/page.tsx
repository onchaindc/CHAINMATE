"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Gamepad2 } from "lucide-react";
import { RequireProfile } from "@/components/auth/require-profile";
import { buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { GuestBanner } from "@/components/auth/guest-banner";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { mergeGamesById, cn } from "@/lib/utils";
import type { GameState } from "@/lib/types";

export default function GamesPage() {
  return (
    <RequireProfile>
      <GamesContent />
    </RequireProfile>
  );
}

function GamesContent() {
  const identity = useIdentity();
  const [games, setGames] = useState<GameState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Map<string, number>>(new Map());
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});

  // Usernames from the server for everyone in this list (real identities).
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  const activeGames =
    games?.filter((g) => g.status === "waiting" || g.status === "active") ?? null;
  const completedGames = games?.filter((g) => !(g.status === "waiting" || g.status === "active")) ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [remote, localGames, profile] = await Promise.all([
          hosted.listMine(),
          Promise.resolve(local.listMyGames()),
          hosted.myProfile(),
        ]);
        if (cancelled) return;
        setGames(mergeGamesById([...remote.games, ...localGames]));
        setPlayers(remote.players);
        setDeltas(
          new Map([
            // Deltas stamped on the games themselves are durable; the stats
            // history is per-instance, so it can be missing entries.
            ...remote.games.flatMap((g) => {
              const change = g.ratings?.[identity.playerId]?.change;
              return change === undefined
                ? []
                : ([[g.id, change]] as [string, number][]);
            }),
            ...profile.stats.ratingHistory.map(
              (h) => [h.gameId, h.change] as [string, number],
            ),
          ]),
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load games");
        setGames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.playerId]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="animate-fade-in-up">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Your record
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">Games</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every match played by {identity.isGuest ? "this device" : "your account"}, from the
          online store and local mode.
        </p>
      </div>

      {identity.isGuest && (
        <div className="mt-6 animate-fade-in-up [animation-delay:60ms]">
          <GuestBanner />
        </div>
      )}

      {/* Active session: games the player joined but hasn't finished or resigned */}
      {activeGames !== null && activeGames.length > 0 && (
        <div className="mt-8 animate-fade-in-up [animation-delay:80ms]">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" aria-hidden />
              Active session
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Finish or resign a game to end your session.
            </p>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-primary/25 bg-card/50">
            <div className="divide-y divide-border/50 px-2 py-2">
              {activeGames.map((game) => (
                <GameRow
                  key={game.id}
                  game={game}
                  me={game.backend === "local" ? localMe : identity.playerId}
                  delta={game.backend === "local" ? null : deltas.get(game.id)}
                  names={game.backend === "local" ? undefined : names}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {activeGames !== null && activeGames.length > 0 && (
        <h2 className="mt-8 animate-fade-in-up text-[11px] font-semibold uppercase tracking-wider text-muted-foreground [animation-delay:80ms]">
          Completed
        </h2>
      )}

      <div
        className={cn(
          "animate-fade-in-up overflow-hidden rounded-lg border border-border/70 bg-card/50 [animation-delay:80ms]",
          activeGames !== null && activeGames.length > 0 && "mt-3",
        )}
      >
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
              Play your first match — create a game or challenge the computer.
            </p>
            <Link href="/create" className={cn(buttonVariants({ size: "sm" }), "mt-5")}>
              Create a game
            </Link>
          </div>
        ) : (completedGames ?? []).length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <p className="text-sm font-medium text-foreground/85">No completed games yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Your finished matches will appear here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50 px-2 py-2">
            {(completedGames ?? []).map((game) => (
              <GameRow
                key={game.id}
                game={game}
                me={game.backend === "local" ? localMe : identity.playerId}
                delta={game.backend === "local" ? null : deltas.get(game.id)}
                names={game.backend === "local" ? undefined : names}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
