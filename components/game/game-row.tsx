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
  /** Rating change for this game (+16 / −12), when known from rating history. */
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
        <p className="truncate text-[11px] text-muted-foreground">
          {game.timeControl ?? "Match"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right">
        <span className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:block">
          {game.timeControl ?? "—"}
        </span>
        <span className="hidden text-xs tabular-nums text-muted-foreground md:block">
          {date}
        </span>
        {delta !== undefined && delta !== null && over && (
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              delta > 0 && "text-primary",
              delta < 0 && "text-[#E07A5F]",
              delta === 0 && "text-muted-foreground",
            )}
            title="Rating change"
          >
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
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
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" aria-hidden />
          )}
          {result}
        </span>
        {colorLabel && (
          <span className="font-mono text-[11px] uppercase text-muted-foreground">
            {colorLabel}
          </span>
        )}
      </div>
    </Link>
  );
}
