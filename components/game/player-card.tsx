"use client";

import { Crown, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { shortId, type PlayerSide } from "@/lib/types";

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
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors",
        isTurn && !waiting
          ? "border-primary/50 bg-primary/10 shadow-[0_0_18px_-6px] shadow-primary/40"
          : "border-border/70 bg-card/60",
        isWinner && "border-accent/60 bg-accent/10",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-base",
            side === "white"
              ? "border-zinc-300 bg-zinc-100 text-zinc-900"
              : "border-zinc-700 bg-zinc-900 text-zinc-100",
          )}
          aria-hidden
        >
          {side === "white" ? "♔" : "♚"}
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            <span className="capitalize">{side}</span>
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
          <p className="flex items-center gap-1 truncate font-mono text-xs text-muted-foreground">
            <User className="h-3 w-3 shrink-0" aria-hidden />
            {playerId ? shortId(playerId) : waiting ? "Waiting…" : "—"}
          </p>
        </div>
      </div>

      {isTurn && !waiting && (
        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />
          to move
        </span>
      )}
      {waiting && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
          waiting
        </span>
      )}
    </div>
  );
}
