"use client";

import { Flag, Swords } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { GameState } from "@/lib/types";

interface StatusBarProps {
  game: GameState;
  turnSide: "white" | "black" | null;
  inCheck: boolean;
}

export function StatusBar({ game, turnSide, inCheck }: StatusBarProps) {
  const { status, winner } = game;

  if (status === "waiting") {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="gold" className="gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
          Waiting for opponent
        </Badge>
      </div>
    );
  }

  if (status === "active") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1.5 capitalize">
          <Swords className="h-3 w-3 text-primary" aria-hidden />
          {turnSide} to move
        </Badge>
        {inCheck && (
          <Badge variant="destructive" className="gap-1">
            <Flag className="h-3 w-3" aria-hidden />
            Check!
          </Badge>
        )}
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
      <Badge variant={winnerSide ? "gold" : "secondary"} className="gap-1.5">
        <Flag className="h-3 w-3" aria-hidden />
        {result[status] ?? status}
      </Badge>
      {winnerSide && (
        <Badge variant="success" className="capitalize">
          {winnerSide} wins
        </Badge>
      )}
    </div>
  );
}
