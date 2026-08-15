"use client";

import { useEffect, useState } from "react";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";

const GLYPHS = ["♔", "♚", "♘", "♖"];
const TINTS = [
  "border-zinc-300 bg-zinc-100 text-zinc-800",
  "border-zinc-600 bg-zinc-800 text-zinc-100",
  "border-primary/50 bg-primary/20 text-primary",
  "border-zinc-500 bg-zinc-700 text-zinc-100",
];

export function SocialProof() {
  const [count, setCount] = useState<number | null>(null);
  const [players, setPlayers] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const [stats, leaderboard] = await Promise.all([
          hosted.stats(),
          hosted.leaderboard(),
        ]);
        if (cancelled) return;
        setCount(stats.gamesThisWeek);
        setPlayers(Math.min(leaderboard.length, 4));
      } catch {
        if (!cancelled) setCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const circleCount = Math.max(players, 1);

  return (
    <div className="mt-8 flex items-center gap-3">
      <div className="flex -space-x-2">
        {Array.from({ length: circleCount }).map((_, i) => (
          <span
            key={i}
            className={`flex h-7 w-7 items-center justify-center rounded-full border text-sm ring-2 ring-background ${TINTS[i % TINTS.length]}`}
            aria-hidden
          >
            {GLYPHS[i % GLYPHS.length]}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {count === null
          ? "Loading platform stats…"
          : count > 0
            ? `${count.toLocaleString()} games played this week`
            : "No games yet this week — be the first."}
      </p>
    </div>
  );
}
