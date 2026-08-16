"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Loader2, Play, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAchievement } from "@/lib/achievements";
import { keyMoments } from "@/lib/summary";
import { cn } from "@/lib/utils";
import { AI_PLAYER_ID, type GameState, type PlayerStats } from "@/lib/types";

interface GameResultProps {
  game: GameState;
  /** Real player stats for both sides (hosted games, humans only). */
  stats: Record<string, PlayerStats>;
  /** The viewing player's id (drives whose achievements to surface). */
  myPlayerId: string;
  busy?: boolean;
  onGenerateSummary: () => void;
  onReplay: () => void;
}

const RESULT_LABEL: Record<string, string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate",
  draw: "Draw",
  resigned: "Resignation",
};

export function GameResult({
  game,
  stats,
  myPlayerId,
  busy,
  onGenerateSummary,
  onReplay,
}: GameResultProps) {
  const winnerSide =
    game.winner === game.creator ? "White" : game.winner === game.opponent ? "Black" : null;
  const moments = useMemo(() => keyMoments(game), [game]);
  const isAiGame = game.opponent === AI_PLAYER_ID;

  // Real rating change for a side, from its rating history (server-computed).
  const ratingLine = (playerId: string) => {
    const s = stats[playerId];
    if (!s) return null;
    const entry = s.ratingHistory.find((h) => h.gameId === game.id);
    if (entry) {
      return { before: entry.ratingBefore, after: entry.ratingAfter, change: entry.change };
    }
    return { before: null, after: s.rating, change: null };
  };

  // Achievements earned in THIS game: awarded server-side at the moment the
  // game ended, so earnedAt lands on the endedAt timestamp.
  const mine = myPlayerId ? stats[myPlayerId] : undefined;
  const unlocked = useMemo(() => {
    if (!mine || !game.endedAt) return [];
    const windowStart = game.endedAt - 5000;
    return (mine.achievements ?? []).filter((a) => a.earnedAt >= windowStart);
  }, [mine, game.endedAt]);

  const playerLine = (side: "white" | "black") => {
    const id = side === "white" ? game.creator : game.opponent;
    const isAi = id === AI_PLAYER_ID;
    const line = ratingLine(id);
    const name = isAi ? "ChainMate AI" : mine && id === myPlayerId ? "You" : undefined;
    return (
      <div className={side === "white" ? "text-left" : "text-right"}>
        <p className="text-sm font-medium text-foreground/90">
          {side === "white" ? "White" : "Black"}
          {name && <span className="text-muted-foreground"> · {name}</span>}
        </p>
        {line ? (
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
            {line.before !== null && (
              <>
                <span>{line.before}</span>
                <span aria-hidden>→</span>
              </>
            )}
            <span className="text-foreground/85">{line.after}</span>
            {line.change !== null && (
              <span
                className={cn(
                  "font-semibold",
                  line.change > 0 ? "text-primary" : line.change < 0 ? "text-[#E07A5F]" : "text-muted-foreground",
                )}
              >
                {line.change > 0 ? `+${line.change}` : line.change}
              </span>
            )}
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {isAi ? "engine" : "unrated"}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border/70 bg-card/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p
            className={cn(
              "font-display text-2xl font-bold uppercase tracking-tight",
              winnerSide ? "text-primary" : "text-foreground",
            )}
          >
            {winnerSide ? `${winnerSide} wins` : "Draw"}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {RESULT_LABEL[game.status] ?? game.status}
            {isAiGame && game.opponent === AI_PLAYER_ID && game.winner === AI_PLAYER_ID
              ? " · the engine had the last word"
              : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onReplay}>
            <Play aria-hidden />
            Replay
          </Button>
          <Link
            href={isAiGame ? "/create?mode=ai" : "/create"}
            className="[&>button]:w-full"
          >
            <Button size="sm">
              <RotateCcw aria-hidden />
              Play again
            </Button>
          </Link>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-secondary/30 px-4 py-3">
        {playerLine("white")}
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          vs
        </span>
        {playerLine("black")}
      </div>

      {unlocked.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {unlocked.map((a) => {
            const def = getAchievement(a.code);
            if (!def) return null;
            return (
              <span
                key={a.code}
                className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary"
              >
                <span aria-hidden>{def.icon}</span>
                Achievement unlocked: {def.name}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-4 border-t border-border/60 pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          What changed the game?
        </p>
        {game.summary ? (
          <p className="mt-2 text-sm leading-relaxed text-foreground/90">{game.summary}</p>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {winnerSide
                ? `${winnerSide} won the game. Want the full breakdown of how it unfolded?`
                : "The game is over. Want to see how it unfolded?"}
            </p>
            <Button
              onClick={onGenerateSummary}
              disabled={busy}
              className="mt-3"
              variant="outline"
              size="sm"
            >
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
          </>
        )}
        {game.summary && (
          <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-foreground/80">
            <li>
              <span className="font-mono text-primary">Opening</span>
              <span className="text-muted-foreground"> — </span>
              {moments.opening}
            </li>
            <li>
              <span className="font-mono text-primary">Turning point</span>
              <span className="text-muted-foreground"> — </span>
              {moments.turningPoint}
            </li>
            <li>
              <span className="font-mono text-primary">Final</span>
              <span className="text-muted-foreground"> — </span>
              {moments.finalTactic}
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
