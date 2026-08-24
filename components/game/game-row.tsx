"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  AI_PLAYER_ID,
  isGameOver,
  type GameIndexEntry,
  type GameState,
} from "@/lib/types";

interface GameRowProps {
  game: GameState | GameIndexEntry;
  /** This browser's identity for the relevant store (drives "You vs …"). */
  me?: string;
  /**
   * Rating change for this game (+16 / −12), when known from rating history.
   * Pass `null` rather than omitting it in a list where *some* rows are rated —
   * null holds the column open, `undefined` removes it from the row entirely.
   */
  delta?: number | null;
  /** Real display names for player ids (usernames from the server). */
  names?: Record<string, string>;
}

export function GameRow({ game, me, delta, names }: GameRowProps) {
  const over = isGameOver(game.status);
  const creator = game.creator;
  const opponent = game.opponent || "";
  const isCreatorMe = Boolean(me && creator === me);
  const isOpponentMe = Boolean(me && opponent === me);
  /**
   * Real username when the server sent one, otherwise the app-wide short-id
   * guest label — a bare "Guest" made every unnamed player look like the same
   * person, which is what made history rows read "Guest vs Guest".
   */
  const nameFor = (id: string) =>
    id === AI_PLAYER_ID
      ? "Computer"
      : names?.[id] || `Guest_${id.slice(0, 4).toUpperCase()}`;
  const opponentLabel = opponent ? nameFor(opponent) : "Waiting…";
  const creatorLabel = nameFor(creator);
  const title = isCreatorMe
    ? `You vs ${opponentLabel}`
    : isOpponentMe
      ? `${creatorLabel} vs You`
      : `${creatorLabel} vs ${opponentLabel}`;

  let result: string;
  if (over) {
    if (game.winner) {
      const winnerSide = game.winner === creator ? "White" : "Black";
      result =
        game.status === "resigned"
          ? `${winnerSide} won · resign`
          : game.status === "timeout"
            ? `${winnerSide} won · timeout`
            : `${winnerSide} won`;
    } else if (game.status === "stalemate") {
      result = "Draw · stalemate";
    } else if (game.status === "aborted") {
      result = "Aborted";
    } else {
      result = "Draw";
    }
  } else if (game.status === "waiting") {
    result = "Waiting";
  } else {
    result = "Live";
  }

  const colorLabel = isCreatorMe ? "W" : isOpponentMe ? "B" : null;
  const ts = game.endedAt ?? game.updatedAt ?? game.createdAt ?? 0;
  const date = ts
    ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
  const href = over ? `/game/${game.id}?replay=1` : `/game/${game.id}`;

  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-secondary/40"
    >
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground/90">{title}</p>
        {/* Narrow screens only: the column version below appears from `sm`, and
            for every width above that this line was printing it a second time. */}
        <p className="truncate font-mono text-2xs text-muted-foreground sm:hidden">
          {game.timeControl ?? "Match"}
        </p>
      </div>
      {/* Fixed-width cells, so the results form a column instead of ending
          wherever each row's text happens to run out. `text-right` is inherited
          by every cell from here. */}
      <div className="flex shrink-0 items-center gap-3 text-right">
        <span className="hidden w-14 font-mono text-xs tabular-nums text-muted-foreground sm:block">
          {game.timeControl ?? "—"}
        </span>
        {/* Mono like the cell beside it — a proportional date next to a
            monospaced time control made the pair look accidentally misaligned. */}
        <span className="hidden w-12 font-mono text-xs tabular-nums text-muted-foreground md:block">
          {date}
        </span>
        {/* The slot is reserved whenever the caller passes `delta` at all, even
            as null: an unrated game in a rated list must still hold the column
            open, or every row after it shifts left. */}
        {delta !== undefined && (
          <span
            className={cn(
              "w-9 font-mono text-xs tabular-nums",
              delta === null || !over
                ? "text-muted-foreground"
                : delta > 0
                  ? "text-positive"
                  : delta < 0
                    ? "text-negative"
                    : "text-muted-foreground",
            )}
            title={delta !== null && over ? "Rating change" : undefined}
          >
            {delta !== null && over ? (delta > 0 ? `+${delta}` : delta) : ""}
          </span>
        )}
        <span
          className={cn(
            "flex w-24 items-center justify-end gap-1.5 text-xs font-medium sm:w-32",
            over
              ? game.winner
                ? "text-primary"
                : "text-muted-foreground"
              : game.status === "active"
                ? "text-primary"
                : "text-muted-foreground",
          )}
        >
          {game.status === "active" && (
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-primary" aria-hidden />
          )}
          <span className="truncate">{result}</span>
        </span>
        {/* Same reservation as the delta cell: which side you played is only
            known for your own games, and the rest must not close the gap. */}
        {me && (
          <span className="w-3 font-mono text-2xs uppercase text-muted-foreground">
            {colorLabel ?? ""}
          </span>
        )}
      </div>
    </Link>
  );
}
