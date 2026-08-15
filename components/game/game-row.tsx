"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  AI_PLAYER_ID,
  isGameOver,
  shortId,
  type GameIndexEntry,
  type GameState,
} from "@/lib/types";

interface GameRowProps {
  game: GameState | GameIndexEntry;
  /** This browser's identity for the relevant store (drives "You vs …"). */
  me?: string;
}

export function GameRow({ game, me }: GameRowProps) {
  const over = isGameOver(game.status);
  const creator = game.creator;
  const opponent = game.opponent || "";
  const isCreatorMe = Boolean(me && creator === me);
  const isOpponentMe = Boolean(me && opponent === me);
  const opponentLabel =
    opponent === AI_PLAYER_ID
      ? "AI"
      : opponent
        ? shortId(opponent)
        : "Waiting…";
  const title = isCreatorMe
    ? `You vs ${opponentLabel}`
    : isOpponentMe
      ? `${shortId(creator)} vs You`
      : `${shortId(creator)} vs ${opponentLabel}`;

  let result: string;
  if (over) {
    if (game.winner) {
      const winnerSide = game.winner === creator ? "White" : "Black";
      result =
        game.status === "resigned" ? `${winnerSide} won · resign` : `${winnerSide} won`;
    } else if (game.status === "stalemate") {
      result = "Draw · stalemate";
    } else {
      result = "Draw";
    }
  } else if (game.status === "waiting") {
    result = "Waiting";
  } else {
    result = "In progress";
  }

  // When we know the viewer's side, tint the result: green win / orange loss.
  const winnerIsMe =
    Boolean(me && game.winner) &&
    ((game.winner === creator && me === creator) ||
      (game.winner === opponent && me === opponent));
  const loserIsMe = Boolean(me && game.winner) && !winnerIsMe && (me === creator || me === opponent);
  const resultClass = over
    ? game.winner
      ? me && (winnerIsMe || loserIsMe)
        ? winnerIsMe
          ? "text-emerald-400"
          : "text-orange-400"
        : "text-primary"
      : "text-muted-foreground"
    : "text-muted-foreground";

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
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {shortId(game.id)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right">
        <span className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:block">
          {game.timeControl ?? "—"}
        </span>
        <span className="hidden text-xs tabular-nums text-muted-foreground md:block">
          {date}
        </span>
        <span className={cn("text-xs font-medium", resultClass)}>{result}</span>
        {colorLabel && (
          <span className="font-mono text-[11px] uppercase text-muted-foreground">
            {colorLabel}
          </span>
        )}
      </div>
    </Link>
  );
}
