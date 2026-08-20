"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Radio, Trophy, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { LiveGameCard } from "@/components/game/live-game-card";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { isGameOver, type GameIndexEntry, type LiveGameEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Watch — the live broadcast feed.
 *
 * Every game that enters LIVE state is registered automatically by the server
 * store (lib/server/hosted.ts) and removed the moment it ends, so this page is
 * always showing real, current matches. It polls the real feed every few
 * seconds; there is no manual "publish" step and no fabricated data.
 */
const POLL_MS = 5000;

export default function WatchPage() {
  const [live, setLive] = useState<LiveGameEntry[]>([]);
  const [open, setOpen] = useState<GameIndexEntry[]>([]);
  const [recent, setRecent] = useState<GameIndexEntry[]>([]);
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hostedMe = useMemo(() => getStore("hosted").getMyPlayerId(), []);
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  /** Player id → username, for the rows that only carry ids. */
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  /** Local (offline) games use the local identity, not the hosted one. */
  const [localIds, setLocalIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    const hosted = getStore("hosted") as HostedGameStore;
    const local = getStore("local") as LocalGameStore;
    const [remote, localGames] = await Promise.all([
      hosted.listWatch(),
      Promise.resolve(local.listMyGames()),
    ]);
    const localRecent = localGames
      .filter((g) => isGameOver(g.status))
      .map<GameIndexEntry>((g) => ({
        id: g.id,
        updatedAt: g.updatedAt ?? 0,
        createdAt: g.createdAt ?? 0,
        creator: g.creator,
        opponent: g.opponent,
        status: g.status,
        winner: g.winner,
        timeControl: g.timeControl,
        visibility: g.visibility,
        endedAt: g.endedAt,
      }));
    setLive(remote.live);
    setOpen(remote.open);
    setPlayers(remote.players);
    setLocalIds(new Set(localRecent.map((e) => e.id)));
    setRecent(mergeEntries([...remote.recent, ...localRecent]));
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        await load();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load matches");
        setLoading(false);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="animate-fade-in-up">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Watch
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">Watch chess</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every active match is broadcast here automatically — follow live
          games, join open ones, or replay a finished game move by move.
        </p>
      </div>

      {error && (
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Live now — real active games from the live registry */}
      <section className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Live now
          </h2>
          {!loading && live.length > 0 && (
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-primary">
              <span className="relative flex h-1.5 w-1.5">
                <span
                  aria-hidden
                  className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60"
                />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              {live.length} active
            </span>
          )}
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {loading ? (
            <div className="space-y-1 px-2 py-3">
              {[0, 1].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : live.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              No live games right now — every active match appears here automatically.
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {live.map((entry) => (
                <LiveGameCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Open games — public matches waiting for an opponent */}
      <section className="mt-8 animate-fade-in-up [animation-delay:140ms]">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Open games
          </h2>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {loading ? (
            <div className="space-y-1 px-2 py-3">
              <div className="h-11 animate-pulse rounded-md bg-secondary/60" />
            </div>
          ) : open.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              No public games waiting for an opponent right now.
            </p>
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {open.map((entry) => (
                <GameRow key={entry.id} game={entry} me={hostedMe} names={names} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Recent completed matches */}
      <section className="mt-8 animate-fade-in-up [animation-delay:200ms]">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent matches
          </h2>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {loading ? (
            <div className="space-y-1 px-2 py-3">
              {[0, 1].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-muted-foreground">No finished matches yet.</p>
              <Link
                href="/create"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
              >
                Play the first one
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {recent.map((entry) => (
                <GameRow
                  key={entry.id}
                  game={entry}
                  /* Offline games were played under the local identity, so
                     "You" only lines up when matched against that one. */
                  me={localIds.has(entry.id) ? localMe : hostedMe}
                  names={localIds.has(entry.id) ? undefined : names}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function mergeEntries(entries: GameIndexEntry[]): GameIndexEntry[] {
  const map = new Map<string, GameIndexEntry>();
  for (const e of entries) map.set(e.id, e);
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
