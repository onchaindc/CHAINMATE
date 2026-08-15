"use client";

import { useMemo } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GameState } from "@/lib/types";
import { AI_PLAYER_ID } from "@/lib/types";
import { keyMoments } from "@/lib/summary";

interface GameOverPanelProps {
  game: GameState;
  busy?: boolean;
  onGenerateSummary: () => void;
}

export function GameOverPanel({ game, busy, onGenerateSummary }: GameOverPanelProps) {
  const winnerSide =
    game.winner === game.creator ? "White" : game.winner === game.opponent ? "Black" : null;
  const resultLabel: Record<string, string> = {
    checkmate: "Checkmate",
    stalemate: "Stalemate",
    draw: "Draw",
    resigned: "Resignation",
  };
  const moments = useMemo(() => keyMoments(game), [game]);
  const isAiGame = game.opponent === AI_PLAYER_ID;

  const playerLine = (side: "white" | "black") => {
    const id = side === "white" ? game.creator : game.opponent;
    const isAi = id === AI_PLAYER_ID;
    return (
      <div className={side === "white" ? "text-left" : "text-right"}>
        <p className="text-sm font-medium capitalize">{side}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {isAi ? "on-device engine" : "player"}
        </p>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border/70 bg-card/50 p-5">
      <p
        className={cn(
          "font-display text-2xl font-bold tracking-tight",
          winnerSide ? "text-primary" : "text-foreground",
        )}
      >
        {winnerSide ? `${winnerSide} wins` : "Draw"}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{resultLabel[game.status] ?? game.status}</p>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/30 px-4 py-3">
        {playerLine("white")}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          vs
        </span>
        {playerLine("black")}
      </div>

      {game.summary ? (
        <>
          <div className="mt-5 border-t border-border/60 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Game analysis
            </p>
            <p className="mt-2 text-sm leading-relaxed text-foreground/90">{game.summary}</p>
          </div>
          <div className="mt-4 border-t border-border/60 pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Key moments
            </p>
            <ul className="mt-2 space-y-2 text-sm leading-relaxed text-foreground/85">
              <li>
                <span className="font-mono text-xs text-primary">Opening</span>
                <span className="text-muted-foreground"> — </span>
                {moments.opening}
              </li>
              <li>
                <span className="font-mono text-xs text-primary">Turning point</span>
                <span className="text-muted-foreground"> — </span>
                {moments.turningPoint}
              </li>
              <li>
                <span className="font-mono text-xs text-primary">Final</span>
                <span className="text-muted-foreground"> — </span>
                {moments.finalTactic}
              </li>
            </ul>
          </div>
        </>
      ) : (
        <div className="mt-5 border-t border-border/60 pt-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {winnerSide
              ? `${winnerSide} won the game. Want a full breakdown of how it unfolded?`
              : "The game is over. Want to see how it unfolded?"}
          </p>
          <Button onClick={onGenerateSummary} disabled={busy} className="mt-3 w-full" variant="outline">
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                Writing analysis…
              </>
            ) : (
              <>
                <Sparkles aria-hidden />
                Generate analysis
              </>
            )}
          </Button>
        </div>
      )}

      <div className="mt-5 flex gap-2 border-t border-border/60 pt-4">
        <Button
          size="sm"
          className="flex-1"
          onClick={() => {
            window.location.href = isAiGame ? "/create?mode=ai" : "/create";
          }}
        >
          Play again
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => {
            window.location.href = "/create";
          }}
        >
          New game
        </Button>
      </div>
    </div>
  );
}
