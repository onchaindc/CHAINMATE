"use client";

import Link from "next/link";
import { Crown } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CountryFlag } from "@/components/ui/country-flag";
import { cn } from "@/lib/utils";
import { type LiveGameEntry } from "@/lib/types";

/**
 * One live match card in the Watch feed. Backed entirely by the server's
 * live-game registry — real players, real ratings, real move counts. The
 * LIVE pulse reflects the actual game state (a game is removed from the feed
 * the moment it ends).
 */
export function LiveGameCard({ entry }: { entry: LiveGameEntry }) {
  const white = entry.creator;
  const black = entry.opponent;
  /** Short-id guest label, matching the rest of the app — a bare "Guest" made
      every unnamed player look like the same person. */
  const guestName = (id: string) => `Guest_${id.slice(0, 4).toUpperCase()}`;
  const whiteName = white.name || guestName(white.id);
  const blackName =
    black.name || (black.isAi ? "ChainMate AI" : black.id ? guestName(black.id) : "Waiting…");

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
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-400 bg-zinc-100 text-zinc-800"
            >
              {/* Lucide crown, not ♔ — the Unicode chess glyphs have no font
                  on Windows and rendered as an empty box. */}
              <Crown className="h-3 w-3" aria-hidden />
            </span>
            <CountryFlag code={white.country} />
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
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-600 bg-zinc-800 text-zinc-100"
            >
              <Crown className="h-3 w-3" aria-hidden />
            </span>
            <CountryFlag code={black.country} />
            <span className="truncate font-medium text-foreground/90">{blackName}</span>
            {typeof black.rating === "number" && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
                {black.rating}
              </span>
            )}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          Move {Math.floor(entry.moveCount / 2) + 1}
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
