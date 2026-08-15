"use client";

import { Badge } from "@/components/ui/badge";
import type { GameState } from "@/lib/types";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  game: GameState;
  turnSide: "white" | "black" | null;
  inCheck: boolean;
}

export function StatusBar({ game, turnSide, inCheck }: StatusBarProps) {
  const { status, winner } = game;
  const moveNumber = Math.floor(game.moves.length / 2) + 1;

  if (status === "waiting") {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" aria-hidden />
          Waiting for opponent
        </span>
      </div>
    );
  }

  if (status === "active") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          Move {moveNumber}
        </span>
        <Badge variant="secondary" className="gap-1.5 capitalize">
          <span className={cn("h-1.5 w-1.5 rounded-full bg-primary", !inCheck && "animate-pulse-soft")} aria-hidden />
          {turnSide} to move
        </Badge>
        {inCheck && <Badge variant="destructive">Check</Badge>}
      </div>
    );
  }

  const result: Record<string, string> = {
    checkmate: "Checkmate",
    stalemate: "Stalemate",
    draw: "Draw",
    resigned: "Resignation",
  };
  const winnerSide = winner === game.creator ? "White" : winner === game.opponent ? "Black" : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={winnerSide ? "gold" : "secondary"} className="capitalize">
        {winnerSide ? `${winnerSide} wins` : result[status] ?? status}
      </Badge>
      {!winnerSide && (
        <span className="text-xs text-muted-foreground">{result[status] ?? status}</span>
      )}
    </div>
  );
}
