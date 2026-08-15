"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { GameRow } from "@/components/game/game-row";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { mergeGamesById } from "@/lib/utils";
import { isGameOver, type GameState } from "@/lib/types";

export function HomeSidebar() {
  const [recent, setRecent] = useState<GameState[] | null>(null);
  const [latest, setLatest] = useState<GameState | null>(null);
  const hostedMe = useMemo(() => getStore("hosted").getMyPlayerId(), []);
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [mine, recentGames] = await Promise.all([
          hosted.listMine(),
          hosted.listRecent(),
        ]);
        if (cancelled) return;
        const localGames = local.listMyGames();
        setRecent(mergeGamesById([...mine, ...localGames]).slice(0, 3));

        const analyzed = [...recentGames, ...localGames]
          .filter((g) => g.summary && isGameOver(g.status))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        setLatest(analyzed[0] ?? null);
      } catch {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const latestResult = latest
    ? latest.winner
      ? latest.winner === latest.creator
        ? "White won"
        : "Black won"
      : "Draw"
    : null;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card/50">
      {/* Latest analysis */}
      <div className="border-b border-border/60">
        <div className="flex items-center gap-2 px-4 py-3">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Latest analysis
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
            engine
          </span>
        </div>
        <div className="px-4 pb-4">
          {latest ? (
            <Link
              href={`/game/${latest.id}?replay=1`}
              className="block transition-colors hover:text-primary"
            >
              <p className="text-sm leading-relaxed text-foreground/90">{latest.summary}</p>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                Move {latest.moves.length} · {latestResult}
              </p>
            </Link>
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              No analyzed games yet. Play a game to generate your first analysis.
            </p>
          )}
        </div>
      </div>

      {/* Recent games */}
      <div>
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent games
          </span>
          <Link
            href="/games"
            className="ml-auto text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            View all →
          </Link>
        </div>
        <div className="pb-1">
          {recent === null ? (
            <div className="space-y-1 px-2 pb-2">
              {[0, 1].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <p className="px-4 pb-4 text-xs text-muted-foreground">
              No games yet — play your first match.
            </p>
          ) : (
            <div className="divide-y divide-border/50 px-1">
              {recent.map((g) => (
                <GameRow
                  key={g.id}
                  game={g}
                  me={g.backend === "local" ? localMe : hostedMe}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
