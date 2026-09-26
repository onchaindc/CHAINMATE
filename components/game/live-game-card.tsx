"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { BotAvatar } from "@/components/game/bot-avatar";
import { SideAvatar } from "@/components/game/side-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { displayNameFor } from "@/lib/identity";
import { cn } from "@/lib/utils";
import { AI_BRAND_SHORT, aiLevelFor, type LiveGameEntry } from "@/lib/types";

/**
 * One live match card in the Watch feed. Backed entirely by the server's
 * live-game registry — real players, real ratings, real move counts. The
 * LIVE pulse reflects the actual game state (a game is removed from the feed
 * the moment it ends).
 */
export function LiveGameCard({ entry }: { entry: LiveGameEntry }) {
  const white = entry.creator;
  const black = entry.opponent;
  /* The bot's side is named by its LEVEL (Pawn, Apex, Stockfish…), falling
     back to the brand when the entry carries no difficulty — and always a
     string, since PlayerAvatar requires one. Humans resolve through
     displayNameFor: real username when one arrived, stable handle otherwise —
     never the bare word "Guest". */
  const botName = entry.aiDifficulty ? aiLevelFor(entry.aiDifficulty).name : AI_BRAND_SHORT;
  const whiteName = white.isAi ? botName : displayNameFor(white.id, white.name);
  const blackName = black.isAi
    ? botName
    : black.id
      ? displayNameFor(black.id, black.name)
      : "Waiting…";

  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:gap-4">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-primary">
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
            {/* A real face when uploaded, the bot's portrait when it is one,
                the side-coloured user disc otherwise. */}
            {white.isAi ? (
              <BotAvatar level={entry.aiDifficulty ?? "stockfish"} size="xs" className="shrink-0" />
            ) : white.avatarUrl ? (
              <PlayerAvatar name={whiteName} avatarUrl={white.avatarUrl} size="xs" className="shrink-0" />
            ) : (
              <SideAvatar side="white" className="h-5 w-5" iconClassName="h-3 w-3" />
            )}
            {!white.isAi && <CountryFlag code={white.country} />}
            <span className="truncate font-medium text-foreground/90">{whiteName}</span>
            {typeof white.rating === "number" && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
                {white.rating}
              </span>
            )}
          </span>
          <span className="hidden shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground sm:block">
            vs
          </span>
          <span className="flex min-w-0 items-center gap-2 text-sm">
            {black.isAi ? (
              <BotAvatar level={entry.aiDifficulty ?? "stockfish"} size="xs" className="shrink-0" />
            ) : black.avatarUrl ? (
              <PlayerAvatar name={blackName} avatarUrl={black.avatarUrl} size="xs" className="shrink-0" />
            ) : (
              <SideAvatar side="black" className="h-5 w-5" iconClassName="h-3 w-3" />
            )}
            {!black.isAi && <CountryFlag code={black.country} />}
            <span className="truncate font-medium text-foreground/90">{blackName}</span>
            {typeof black.rating === "number" && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-primary">
                {black.rating}
              </span>
            )}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-2xs tabular-nums text-muted-foreground">
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
