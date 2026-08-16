"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { shortId, type LiveGameEntry } from "@/lib/types";

/**
 * One live match card in the Watch feed. Backed entirely by the server's
 * live-game registry — real players, real ratings, real move counts. The
 * LIVE pulse reflects the actual game state (a game is removed from the feed
 * the moment it ends).
 */
export function LiveGameCard({ entry }: { entry: LiveGameEntry }) {
  const white = entry.creator;
  const black = entry.opponent;
  const whiteName = white.name ?? shortId(white.id);
  const blackName = black.name ?? (black.isAi ? "ChainMate AI" : shortId(black.id));

  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:gap-4">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
        <span className="relative flex h-1.5 w-1.5">
          <span
            aria-hidden
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60"
          />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        Live
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-400 bg-zinc-100 text-[10px] text-zinc-800"
            >
              ♔
            </span>
            <span className="truncate font-medium text-foreground/90">{whiteName}</span>
            {typeof white.rating === "number" && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
                {white.rating}
              </span>
            )}
          </span>
          <span className="hidden shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:block">
            vs
          </span>
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-600 bg-zinc-800 text-[10px] text-zinc-100"
            >
              ♚
            </span>
            <span className="truncate font-medium text-foreground/90">{blackName}</span>
            {typeof black.rating === "number" && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
                {black.rating}
              </span>
            )}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          Move {entry.moveCount}
          {entry.timeControl ? ` · ${entry.timeControl}` : ""}
        </p>
      </div>

      <Link
        href={`/game/${entry.id}`}
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "shrink-0")}
      >
        Watch
      </Link>
    </div>
  );
}
