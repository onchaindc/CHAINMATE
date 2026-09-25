"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Play, RotateCcw, Sparkles, Trophy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAchievement } from "@/lib/achievements";
import { describeResult } from "@/lib/game-result";
import { guestDisplayName } from "@/lib/identity";
import { displaySummary, keyMoments } from "@/lib/summary";
import { cn } from "@/lib/utils";
import {
  AI_BRAND_SHORT,
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
  /** True while a match-analysis request is in flight. Always false: the AI
      commentary was removed from the product. The prop remains so existing
      call sites keep compiling. */
  analyzing?: boolean;
  onGenerateSummary?: () => void;
  /** One-click rematch against the same opponent (hosted human games).
   *  NEVER offered for tournament matches — the bracket decides what
   *  happens next. */
  onRematch?: () => Promise<void>;
  /** Tournament match: the result hands the player back to the event. */
  tournamentId?: string;
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
  tournamentId,
  onRematch,
  onReplay,
  onClose,
}: EndGameModalProps) {
  const { verdict, reason, detail, won } = describeResult(game, mySide);

  // Real rating change for a side. The game itself carries both deltas (written
  // server-side when it ended), so this works for whichever player is looking
  // and from any server instance; the stats history is only a fallback for
  // games that finished before deltas were recorded there.
  const ratingLine = (playerId: string) => {
    const stamped = game.ratings?.[playerId];
    if (stamped) {
      return { before: stamped.before, after: stamped.after, change: stamped.change };
    }
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

  /* The match report: the deterministic summary written the moment the game
     ended. AI commentary was removed from the product; there is no second
     layer to wait for any more. */
  const report = displaySummary(game);

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
        : guestDisplayName(stats[id]?.username);
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
                  line.change > 0 ? "text-primary" : line.change < 0 ? "text-negative" : "text-muted-foreground",
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
            <span className="normal-case">{isAi ? AI_BRAND_SHORT : "provisional"}</span>
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        className="animate-fade-in-up max-h-[92vh] w-full overflow-y-auto rounded-t-xl border border-border/70 bg-card p-5 shadow-elevation-3 sm:max-w-md sm:rounded-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — the verdict is the hero, the congratulation (or its
            gentle inverse) sits right under it. This is where the old
            always-on page report strip now lives. */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
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
            {won && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Well played — the win is yours.
              </p>
            )}
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close result" className="shrink-0">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        {/* Players + rating changes — borderless rows over a soft tint, the
            app's modern surface language, instead of a boxed grid. */}
        <div className="mt-4 space-y-2 rounded-lg bg-secondary/25 px-4 py-3">
          {playerCell("white")}
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border/50" aria-hidden />
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              vs
            </span>
            <span className="h-px flex-1 bg-border/50" aria-hidden />
          </div>
          {playerCell("black")}
        </div>

        {/* Casual games are casual by design — say so, don't leave it unexplained. */}
        {isAiGame && (
          <p className="mt-2.5 text-center text-2xs leading-snug text-muted-foreground">
            Casual match, bot games never change your rating.
          </p>
        )}
        {!isAiGame &&
          [game.creator, game.opponent].some((id) => stats[id]?.isGuest) && (
            <p className="mt-2.5 text-center text-2xs leading-snug text-muted-foreground">
              Casual match, guest games never change a rating. Sign up for
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

        {/* Match report. The deterministic report is written the moment a game
            ends, so there is always something here; the LLM analysis replaces
            it in place when it lands. */}
        <div className="mt-4 border-t border-border/60 pt-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            What changed the game?
          </p>
          {report && (
            <p className="mt-2 text-sm leading-relaxed text-foreground/90">{report}</p>
          )}

          <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-foreground/80">
            <li>
              <span className="font-mono text-primary">Opening</span>
              <span className="text-muted-foreground">: </span>
              {moments.opening}
            </li>
            <li>
              <span className="font-mono text-primary">Turning point</span>
              <span className="text-muted-foreground">: </span>
              {moments.turningPoint}
            </li>
            <li>
              <span className="font-mono text-primary">Final</span>
              <span className="text-muted-foreground">: </span>
              {moments.finalTactic}
            </li>
          </ul>
        </div>

        {/* Actions */}
        <div className="mt-5 flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onReplay}>
            <Play aria-hidden />
            Replay
          </Button>
          {/* A tournament match flows back into the event — the bracket, not
              the players, decides what happens next. No rematch, no "play
              again", no casual next game from inside the popup. */}
          {tournamentId ? (
            <Link href={`/tournaments/${tournamentId}`} className="flex-1">
              <Button className="w-full">
                <Trophy aria-hidden />
                Back to tournament
              </Button>
            </Link>
          ) : onRematch ? (
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
            <Link
              href={
                /* Carry the opponent across to Solo. Without the level, a
                   rematch after losing to Zenith lands on the default and the
                   player has to re-pick the level they just played.
                   `normalizeAiDifficulty` on the other end absorbs a missing or
                   legacy value, so an old game with no `aiDifficulty` is safe. */
                isAiGame
                  ? `/solo${game.aiDifficulty ? `?level=${game.aiDifficulty}` : ""}`
                  : "/create"
              }
              className="flex-1"
            >
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
