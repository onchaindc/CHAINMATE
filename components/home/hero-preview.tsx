"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BoardVisual } from "@/components/landing/board-visual";
import { GameRow } from "@/components/game/game-row";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { mergeGamesById } from "@/lib/utils";
import { isGameOver, type GameState } from "@/lib/types";

export function HeroPreview() {
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
        const merged = mergeGamesById([...mine, ...localGames]);
        setRecent(merged.slice(0, 3));

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
    <div className="mx-auto w-full max-w-md">
      <BoardVisual />

      <div className="mt-6 space-y-6">
        {/* Latest analysis */}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Latest analysis
          </h3>
          {latest ? (
            <Link
              href={`/game/${latest.id}?replay=1`}
              className="mt-2 block rounded-lg border border-border/60 bg-card/50 p-4 transition-colors hover:border-primary/40"
            >
              <div className="flex items-center gap-2">
                <img src="/logo-mark.svg" alt="" className="h-4 w-4" />
                <span className="font-mono text-xs text-primary">
                  Move {latest.moves.length} · {latestResult}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-foreground/85">
                {latest.summary}
              </p>
              <span className="mt-2 inline-block text-xs font-medium text-primary">
                View game →
              </span>
            </Link>
          ) : (
            <div className="mt-2 rounded-lg border border-border/60 bg-card/50 px-4 py-4">
              <p className="text-sm text-foreground/85">No analyzed games yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Play a game to generate your first analysis.
              </p>
            </div>
          )}
        </section>

        {/* Recent games */}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent games
          </h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-card/50">
            {recent === null ? (
              <div className="space-y-1 px-2 py-2">
                {[0, 1].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-secondary/60" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                No games yet — play your first match.
              </p>
            ) : (
              <div className="divide-y divide-border/50 px-1 py-1">
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
        </section>
      </div>
    </div>
  );
}
