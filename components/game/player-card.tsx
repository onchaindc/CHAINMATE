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
}

export function PlayerCard({
  side,
  playerId,
  isYou,
  isWinner,
  isTurn,
  waiting,
}: PlayerCardProps) {
  const isAi = playerId === AI_PLAYER_ID;

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
            <span className="capitalize">{side}</span>
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
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {isAi ? "on-device engine" : playerId ? shortId(playerId) : waiting ? "Waiting…" : "—"}
          </p>
        </div>
      </div>

      {isTurn && !waiting ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary">
          <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
          to move
        </span>
      ) : waiting ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1 w-1 animate-pulse-soft rounded-full bg-primary/60" aria-hidden />
          waiting
        </span>
      ) : null}
    </div>
  );
}
