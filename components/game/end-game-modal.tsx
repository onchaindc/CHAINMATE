"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Play, RotateCcw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAchievement } from "@/lib/achievements";
import { describeResult } from "@/lib/game-result";
import { keyMoments } from "@/lib/summary";
import { cn } from "@/lib/utils";
import {
  AI_PLAYER_ID,
  aiLevelFor,
  type GameState,
  type PlayerSide,
  type PlayerStats,
} from "@/lib/types";

interface EndGameModalProps {
  game: GameState;
  /** Real player stats for both sides (hosted games, humans only). */
  stats: Record<string, PlayerStats>;
  /** The viewing player's id (drives \"You won/lost\" + whose achievements). */
  myPlayerId: string;
  /** The viewing player's side — null when spectating. */
  mySide: PlayerSide | null;
  busy?: boolean;
  onGenerateSummary: () => void;
  /** One-click rematch against the same opponent (hosted human games). */
  onRematch?: () => Promise<void>;
  onReplay: () => void;
  onClose: () => void;
}

/**
 * The end-of-match modal. Shown automatically the moment any game ends, on
 * the same /game/[id] URL — the live game transitions to the completed-game
 * experience behind it (board becomes a replay). Every number shown comes
 * from the real game state: the result, the termination reason, per-player
 * rating deltas, achievements actually earned, and the match summary.
 *
 * The result wording comes from lib/game-result.ts, shared with the persistent
 * result banner on the page so the two can never disagree about the same game.
 */
export function EndGameModal({
  game,
  stats,
  myPlayerId,
  mySide,
  busy,
  onGenerateSummary,
  onRematch,
  onReplay,
  onClose,
}: EndGameModalProps) {
  const { verdict, reason, detail, winnerSide, won } = describeResult(game, mySide);

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

  const moments = useMemo(() => keyMoments(game), [game]);
  const isAiGame = game.opponent === AI_PLAYER_ID;
  const [rematching, setRematching] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const playerCell = (side: "white" | "black") => {
    const id = side === "white" ? game.creator : game.opponent;
    const isAi = id === AI_PLAYER_ID;
    const line = ratingLine(id);
    const isViewer = id === myPlayerId;
    const name = isAi
      ? aiLevelFor(game.aiDifficulty).name
      : isViewer
        ? "You"
        : stats[id]?.username ?? "Guest";
    return (
      <div className={side === "white" ? "min-w-0 text-left" : "min-w-0 text-right"}>
        <p className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {side}
          {name && <span className="normal-case text-foreground/80"> · {name}</span>}
        </p>
        {line ? (
          <p className="mt-1 flex items-center gap-1.5 font-mono text-sm tabular-nums text-muted-foreground">
            {line.before !== null && (
              <>
                <span>{line.before}</span>
                <span aria-hidden>→</span>
              </>
            )}
            <span className="text-foreground/90">{line.after}</span>
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
          <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="text-foreground/80">
              {isAi ? aiLevelFor(game.aiDifficulty).rating : 1200}
            </span>
            <span className="normal-case">{isAi ? "Computer" : "provisional"}</span>
          </p>
        )}
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Match result"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        className="animate-fade-in-up max-h-[92vh] w-full overflow-y-auto rounded-t-xl border border-border/70 bg-card p-5 shadow-2xl sm:max-w-md sm:rounded-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Match result
            </p>
            <h2
              className={cn(
                "font-display mt-1.5 text-3xl font-bold tracking-tight",
                won ? "text-primary" : "text-foreground",
              )}
            >
              {verdict}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground/90">{detail}</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close result" className="shrink-0">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        {/* Players + rating changes */}
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-secondary/30 px-4 py-3">
          {playerCell("white")}
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            vs
          </span>
          {playerCell("black")}
        </div>

        {/* Casual games are casual by design — say so, don't leave it unexplained. */}
        {isAiGame && (
          <p className="mt-2.5 text-center text-[11px] leading-snug text-muted-foreground">
            Casual match — games against the computer never change your rating.
          </p>
        )}
        {!isAiGame &&
          [game.creator, game.opponent].some((id) => stats[id]?.isGuest) && (
            <p className="mt-2.5 text-center text-[11px] leading-snug text-muted-foreground">
              Casual match — guest games never change a rating. Sign up for
              rated play.
            </p>
          )}

        {/* Achievements actually earned in this game */}
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

        {/* Summary */}
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
                  ? `${winnerSide === "white" ? "White" : "Black"} won the game. Want the full breakdown of how it unfolded?`
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

        {/* Actions */}
        <div className="mt-5 flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onReplay}>
            <Play aria-hidden />
            Replay
          </Button>
          {onRematch ? (
            <Button
              className="flex-1"
              disabled={rematching}
              onClick={() => {
                setRematching(true);
                void onRematch().finally(() => setRematching(false));
              }}
            >
              {rematching ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <RotateCcw aria-hidden />
              )}
              Rematch
            </Button>
          ) : (
            <Link href={isAiGame ? "/create?mode=ai" : "/create"} className="flex-1">
              <Button className="w-full">
                <RotateCcw aria-hidden />
                Play again
              </Button>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
