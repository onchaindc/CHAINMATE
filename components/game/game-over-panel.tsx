"use client";

import { FileText, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { GameState } from "@/lib/types";

interface GameOverPanelProps {
  game: GameState;
  busy?: boolean;
  onGenerateSummary: () => void;
}

export function GameOverPanel({ game, busy, onGenerateSummary }: GameOverPanelProps) {
  const winnerSide =
    game.winner === game.creator ? "White" : game.winner === game.opponent ? "Black" : null;

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        winnerSide ? "border-accent/40 bg-accent/5" : "border-border/70 bg-card/60",
      )}
    >
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-accent" aria-hidden />
        <h3 className="text-sm font-semibold">Match analysis</h3>
        {game.backend === "genlayer" && (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            stored on-chain
          </Badge>
        )}
      </div>

      {game.summary ? (
        <p className="mt-3 text-sm leading-relaxed text-foreground/90">{game.summary}</p>
      ) : (
        <div className="mt-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {winnerSide
              ? `${winnerSide} won the game. Want a full breakdown of how it unfolded?`
              : "The game is over. Want to see how it unfolded?"}
          </p>
          <Button
            onClick={onGenerateSummary}
            disabled={busy}
            className="mt-3 w-full"
            variant="outline"
          >
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                {game.backend === "genlayer"
                  ? "Validators are writing the analysis…"
                  : "Writing analysis…"}
              </>
            ) : (
              <>
                <Sparkles aria-hidden />
                Generate AI analysis
              </>
            )}
          </Button>
          {game.backend === "genlayer" && !busy && (
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground/70">
              On-chain LLM summaries are written by the GenLayer validators and can
              take up to a minute.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
