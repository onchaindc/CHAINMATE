"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Radio, Trophy } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { isGameOver, type GameIndexEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

interface WatchData {
  live: GameIndexEntry[];
  recent: GameIndexEntry[];
  loading: boolean;
  error: string | null;
}

export default function WatchPage() {
  const [data, setData] = useState<WatchData>({ live: [], recent: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [remote, localGames] = await Promise.all([
          hosted.listWatch(),
          Promise.resolve(local.listMyGames()),
        ]);
        if (cancelled) return;
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
        const recent = mergeEntries([...remote.recent, ...localRecent]);
        setData({ live: remote.live, recent, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setData({
          live: [],
          recent: [],
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load matches",
        });
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
          Watch
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">Watch chess</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Join a public game that&rsquo;s waiting for an opponent, or replay a
          finished match move by move.
        </p>
      </div>

      {data.error && (
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{data.error}</p>
        </div>
      )}

      {/* Live public games */}
      <section className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Live · open games
          </h2>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {data.loading ? (
            <div className="space-y-1 px-2 py-3">
              {[0, 1].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : data.live.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">
              No public games waiting for an opponent right now.
            </p>
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {data.live.map((entry) => (
                <GameRow key={entry.id} game={entry} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Recent completed matches */}
      <section className="mt-8 animate-fade-in-up [animation-delay:140ms]">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent matches
          </h2>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {data.loading ? (
            <div className="space-y-1 px-2 py-3">
              {[0, 1].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : data.recent.length === 0 ? (
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
              {data.recent.map((entry) => (
                <GameRow key={entry.id} game={entry} />
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
