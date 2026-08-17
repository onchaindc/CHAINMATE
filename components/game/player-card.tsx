"use client";

import { Crown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AI_PLAYER_ID, type PlayerSide } from "@/lib/types";

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
  /** Whether the side to move is in check (shown on their card). */
  inCheck?: boolean;
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
  inCheck,
}: PlayerCardProps) {
  const isAi = playerId === AI_PLAYER_ID;
  const displayName = name ?? (isAi ? "ChainMate AI" : "Guest");
  const active = isTurn && !waiting;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        active ? "border-primary/40 bg-primary/[0.06]" : "border-border/60 bg-card/40",
        isWinner && "border-primary/50 bg-accent/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-base",
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
          <p className="flex items-center gap-2 truncate text-[11px] text-muted-foreground">
            {rating !== null && rating !== undefined && (
              <span className="font-mono tabular-nums text-primary">{rating}</span>
            )}
            <span className="truncate">
              {isAi
                ? "Computer"
                : waiting
                  ? "Waiting…"
                  : name
                    ? ""
                    : "Guest"}
            </span>
            {active && (
              <span className="flex shrink-0 items-center gap-1.5 font-medium text-primary">
                <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
                to move
                {inCheck && <span className="text-[#E07A5F]">· check</span>}
              </span>
            )}
          </p>
        </div>
      </div>

      {clock !== null && clock !== undefined && (
        <span
          className={cn(
            "min-w-[4.75rem] shrink-0 rounded-md border px-3 py-1.5 text-center font-mono text-xl font-semibold leading-none tabular-nums transition-colors duration-300 sm:text-2xl",
            clockLow
              ? "border-[#E07A5F]/45 bg-[#E07A5F]/10 text-[#E07A5F]"
              : active
                ? "border-primary/45 bg-primary/[0.08] text-foreground"
                : "border-border/70 bg-secondary/30 text-foreground/85",
          )}
          aria-label={`${side === "white" ? "White" : "Black"} clock`}
        >
          {clock}
        </span>
      )}
    </div>
  );
}
