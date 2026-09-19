"use client";

import Link from "next/link";
import { guestDisplayName } from "@/lib/identity";
import { cn } from "@/lib/utils";
import {
  Award,
  Bot,
  Clock,
  Equal,
  Flag,
  User,
  XCircle,
} from "lucide-react";
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

/**
 * One recent game, readable at a glance.
 *
 * The old row read as a sentence — "You vs Abdulxbt · White won · resign" —
 * which took actual reading to parse. This layout says the same thing in
 * shape: opponent first (with your colour as a tiny disc), then the meta
 * (time control, date, rating delta), then a colour-coded result chip. Win
 * rows glow, losses recede, draws sit neutral — scanning a page of results
 * takes a glance instead of a read.
 */
export function GameRow({ game, me, delta, names }: GameRowProps) {
  const over = isGameOver(game.status);
  const creator = game.creator;
  const opponent = game.opponent || "";
  const isCreatorMe = Boolean(me && creator === me);
  const isOpponentMe = Boolean(me && opponent === me);
  const mine = isCreatorMe || isOpponentMe;
  /**
   * Real username when the server sent one, otherwise a plain "Guest".
   *
   * Routed through `guestDisplayName` rather than `names?.[id] || "Guest"`:
   * `upsertProfiles` (db.ts) synthesises `Guest_XXXX` into the username
   * column, so the server can hand back a non-empty name that `||` passes
   * straight through — putting the short id back on screen.
   */
  const nameFor = (id: string) =>
    id === AI_PLAYER_ID ? "Computer" : guestDisplayName(names?.[id]);

  /** The player this row is ABOUT: me when I played, else the creator. */
  const primaryId = mine ? (isCreatorMe ? creator : opponent) : creator;
  /** The other side. Empty while a challenge is still waiting. */
  const vsId = mine
    ? isCreatorMe
      ? opponent
      : creator
    : opponent || "";

  const primaryName = nameFor(primaryId);
  const isVsComputer = vsId === AI_PLAYER_ID;
  const vsName = vsId ? nameFor(vsId) : "";
  /** Which side I (or the primary player) sat on. */
  const primaryIsWhite = primaryId === creator;
  const waiting = game.status === "waiting" || !vsId;

  /* ----- Result: one clean state per outcome ---------------------------- */
  let chip: { label: string; tone: "win" | "loss" | "draw" | "live" | "waiting"; icon?: React.ReactNode };
  if (over) {
    if (game.winner) {
      const iWon = mine && game.winner === primaryId;
      if (game.status === "resigned") {
        chip = {
          label: iWon ? "Win · resign" : mine ? "Lost · resign" : "Resign",
          tone: iWon ? "win" : mine ? "loss" : "draw",
          icon: <Flag className="h-3 w-3" aria-hidden />,
        };
      } else if (game.status === "timeout") {
        chip = {
          label: iWon ? "Win · time" : mine ? "Lost · time" : "Time",
          tone: iWon ? "win" : mine ? "loss" : "draw",
          icon: <Clock className="h-3 w-3" aria-hidden />,
        };
      } else {
        chip = {
          label: iWon ? "Win" : mine ? "Loss" : "Decided",
          tone: iWon ? "win" : mine ? "loss" : "draw",
          icon: <Award className="h-3 w-3" aria-hidden />,
        };
      }
    } else if (game.status === "aborted") {
      chip = {
        label: "Aborted",
        tone: "draw",
        icon: <XCircle className="h-3 w-3" aria-hidden />,
      };
    } else {
      chip = {
        label: "Draw",
        tone: "draw",
        icon: <Equal className="h-3 w-3" aria-hidden />,
      };
    }
  } else if (waiting) {
    chip = { label: "Waiting", tone: "waiting" };
  } else {
    chip = { label: "Live", tone: "live" };
  }

  const colorLabel = mine ? (primaryIsWhite ? "W" : "B") : null;
  const ts = game.endedAt ?? game.updatedAt ?? game.createdAt ?? 0;
  const date = ts
    ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
  const href = over ? `/game/${game.id}?replay=1` : `/game/${game.id}`;

  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-secondary/40"
    >
      {/* Who: the row's primary player, with the played colour as a disc so a
          page of rows reads like a card list, not a sentence. */}
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold",
          primaryIsWhite
            ? "border-piece-outline/30 bg-piece-light text-piece-dark"
            : "border-piece-outline/30 bg-piece-dark text-piece-light",
        )}
        title={colorLabel ? `You played ${primaryIsWhite ? "White" : "Black"}` : undefined}
      >
        {colorLabel ?? ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {primaryName}
          </span>
          {/* Your own rows label themselves so "You" stays out of the middle
              of a name pair — the tiny badge does the pointing. */}
          {mine && (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-2xs font-semibold uppercase tracking-wide text-primary">
              you
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
          {isVsComputer ? (
            <Bot className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <User className="h-3 w-3 shrink-0" aria-hidden />
          )}
          {waiting ? (
            <span>waiting for an opponent</span>
          ) : (
            <span className="truncate">vs {vsName}</span>
          )}
          <span aria-hidden>·</span>
          <span className="shrink-0 font-mono tabular-nums">{game.timeControl ?? "Match"}</span>
          <span aria-hidden className="hidden sm:inline">·</span>
          <span className="hidden shrink-0 font-mono tabular-nums sm:inline">{date}</span>
        </span>
      </span>
      {/* Rating delta, when the caller passes deltas at all: held open for
          unrated rows so the column never shifts. */}
      {delta !== undefined && (
        <span
          className={cn(
            "w-10 shrink-0 text-right font-mono text-xs tabular-nums",
            delta !== null && over && delta > 0 && "text-positive",
            delta !== null && over && delta < 0 && "text-negative",
            (delta === null || !over) && "text-muted-foreground/50",
          )}
          title={delta !== null && over ? "Rating change" : undefined}
        >
          {delta !== null && over ? (delta > 0 ? `+${delta}` : delta) : "—"}
        </span>
      )}
      {/* Result chip: colour does the scanning, the word does the confirming. */}
      <span
        className={cn(
          "flex w-[5.5rem] shrink-0 items-center justify-end gap-1.5 text-xs font-medium",
          chip.tone === "win" && "text-positive",
          chip.tone === "loss" && "text-muted-foreground",
          chip.tone === "draw" && "text-foreground/70",
          chip.tone === "live" && "text-primary",
          chip.tone === "waiting" && "text-muted-foreground/70",
        )}
      >
        {chip.tone === "live" && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-primary" aria-hidden />
        )}
        {chip.icon}
        <span className="truncate">{chip.label}</span>
      </span>
    </Link>
  );
}
