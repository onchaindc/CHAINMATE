"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { AchievementGrid } from "@/components/game/achievement-grid";
import { GuestBanner } from "@/components/auth/guest-banner";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { mergeGamesById, cn } from "@/lib/utils";
import type { GameState, PlayerStats } from "@/lib/types";

export default function ProfilePage() {
  const identity = useIdentity();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [games, setGames] = useState<GameState[] | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});
  const [error, setError] = useState<string | null>(null);

  // Real usernames for everyone in the recent-games list.
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  // The active player id: the account's id when signed in, the device
  // guest id otherwise.
  const playerId = identity.playerId;
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
        setPlayers(profile.players);
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
    // playerId drives the fetch — refresh when identity changes.
  }, [playerId]);

  const name = identity.username || "Player";
  const rating = stats?.rating ?? identity.rating;
  const provisional = stats ? stats.games < 5 : false;
  const winRate =
    stats && stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : null;
  const streak = stats?.currentStreak ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="animate-fade-in-up flex flex-wrap items-center gap-4">
        <PlayerAvatar name={name} size="lg" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display truncate text-2xl font-bold tracking-tight">{name}</h1>
            {identity.isGuest ? (
              <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Guest
              </span>
            ) : (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                Account
              </span>
            )}
            {stats && provisional && (
              <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Provisional
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {identity.isGuest
              ? "Guest player — progress is saved on this device"
              : "ChainMate player — signed in and synced across devices"}
          </p>
        </div>
        {rating !== null && (
          <div className="ml-auto text-right">
            <p className="font-mono text-2xl font-bold tabular-nums text-primary">{rating}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              ELO rating
            </p>
          </div>
        )}
      </div>

      {identity.isGuest && (
        <div className="mt-6 animate-fade-in-up [animation-delay:60ms]">
          <GuestBanner />
        </div>
      )}

      {error && (
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-8 grid animate-fade-in-up grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 sm:grid-cols-5">
        {[
          { label: "Games", value: stats ? String(stats.games) : "—" },
          { label: "Wins", value: stats ? String(stats.wins) : "—" },
          { label: "Losses", value: stats ? String(stats.losses) : "—" },
          { label: "Draws", value: stats ? String(stats.draws) : "—" },
          {
            label: "Win rate",
            value: winRate !== null ? `${winRate}%` : "—",
          },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-xl font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid animate-fade-in-up grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 [animation-delay:80ms]">
        {[
          { label: "Peak rating", value: stats ? String(stats.peakRating) : "—" },
          {
            label: "Streak",
            value: stats ? (streak === 0 ? "—" : `${streak > 0 ? "+" : ""}${streak}`) : "—",
          },
          { label: "Best streak", value: stats ? `+${stats.bestStreak}` : "—" },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-lg font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {provisional
          ? "Provisional rating — updates after rated online matches between two human players."
          : "Rating and streaks update after rated online matches between two human players."}
      </p>

      {/* Achievements */}
      <div className="mt-10 animate-fade-in-up [animation-delay:120ms]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Achievements
          {stats && stats.achievements.length > 0 && (
            <span className="ml-2 font-mono text-primary">
              {stats.achievements.length}/{10}
            </span>
          )}
        </h2>
        <div className="mt-3">
          {stats ? (
            <AchievementGrid stats={stats} />
          ) : (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-secondary/60" />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent games */}
      <div className="mt-10 animate-fade-in-up [animation-delay:160ms]">
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
                  me={game.backend === "local" ? localMe : playerId}
                  names={game.backend === "local" ? undefined : names}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
