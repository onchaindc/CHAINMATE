"use client";

import { Bot, Crown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AI_PLAYER_ID, shortId, type PlayerSide } from "@/lib/types";

interface PlayerCardProps {
  side: PlayerSide;
  playerId: string;
  isYou: boolean;
  isWinner: boolean;
  isTurn: boolean;
  waiting?: boolean;
  /** Display name (username when known, otherwise the short player id). */
  name?: string;
  /** Current ELO rating when known (real server data). */
  rating?: number | null;
  /** Formatted clock ("08:42") when the game has a time control. */
  clock?: string | null;
  clockLow?: boolean;
}

export function PlayerCard({
  side,
  playerId,
  isYou,
  isWinner,
  isTurn,
  waiting,
  name,
  rating,
  clock,
  clockLow,
}: PlayerCardProps) {
  const isAi = playerId === AI_PLAYER_ID;
  const displayName = name ?? (isAi ? "ChainMate AI" : shortId(playerId));

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        isTurn && !waiting
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/60 bg-card/40",
        isWinner && "border-primary/50 bg-accent/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm",
            side === "white"
              ? "border-zinc-400 bg-zinc-100 text-zinc-800"
              : "border-zinc-600 bg-zinc-800 text-zinc-100",
          )}
          aria-hidden
        >
          {side === "white" ? "♔" : "♚"}
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            <span className="truncate capitalize">{displayName}</span>
            {isAi && (
              <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                <Bot className="h-3 w-3" aria-hidden />
                AI
              </Badge>
            )}
            {isYou && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                you
              </Badge>
            )}
            {isWinner && (
              <Badge variant="gold" className="gap-1 px-1.5 py-0 text-[10px]">
                <Crown className="h-3 w-3" aria-hidden />
                winner
              </Badge>
            )}
          </p>
          <p className="flex items-center gap-2 truncate font-mono text-[11px] text-muted-foreground">
            {rating !== null && rating !== undefined ? (
              <span className="tabular-nums text-primary">{rating}</span>
            ) : null}
            <span className="truncate">
              {isAi
                ? "on-device engine"
                : playerId
                  ? shortId(playerId)
                  : waiting
                    ? "Waiting…"
                    : "—"}
            </span>
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {clock !== null && clock !== undefined && (
          <span
            className={cn(
              "font-mono text-lg font-semibold leading-none tabular-nums",
              clockLow ? "text-[#E07A5F]" : "text-foreground/90",
            )}
          >
            {clock}
          </span>
        )}
        {isTurn && !waiting ? (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
            <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
            to move
          </span>
        ) : waiting ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-1 w-1 animate-pulse-soft rounded-full bg-primary/60" aria-hidden />
            waiting
          </span>
        ) : null}
      </div>
    </div>
  );
}
