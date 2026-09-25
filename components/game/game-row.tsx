"use client";

import Link from "next/link";
import { guestDisplayName } from "@/lib/identity";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { BotAvatar } from "@/components/game/bot-avatar";
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
  AI_BRAND_SHORT,
  AI_PLAYER_ID,
  isGameOver,
  type GameIndexEntry,
  type GameState,
} from "@/lib/types";
import type { PlayerInfo } from "@/lib/store/hosted-store";

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
  /** Real display info for player ids (usernames, avatars from the server). */
  players?: Record<string, PlayerInfo>;
  /**
   * This browser's real display name, when the row's store can't supply one.
   * Local/AI games run on the device store, whose records carry no server
   * profile — without this the signed-in player's OWN row fell back to the
   * generic guest label ("Guest vs CM Grandmaster"), which read as a data bug.
   */
  meName?: string;
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
export function GameRow({ game, me, delta, players, meName }: GameRowProps) {
  const over = isGameOver(game.status);
  const creator = game.creator;
  const opponent = game.opponent || "";
  const isCreatorMe = Boolean(me && creator === me);
  const isOpponentMe = Boolean(me && opponent === me);
  const mine = isCreatorMe || isOpponentMe;
  /**
   * Real username when the server sent one, otherwise a plain "Guest".
   *
   * Routed through `guestDisplayName` rather than `players?.[id]?.name || "Guest"`:
   * `upsertProfiles` (db.ts) synthesises `Guest_XXXX` into the username
   * column, so the server can hand back a non-empty name that `||` passes
   * straight through — putting the short id back on screen.
   */
  const nameFor = (id: string) =>
    id === AI_PLAYER_ID
      ? AI_BRAND_SHORT
      : id === me && meName
        ? meName
        : guestDisplayName(players?.[id]?.name);

  /**
   * The row is ABOUT the opponent — the person you played. A waiting game
   * (no opponent yet) falls back to the creator, i.e. you.
   */
  const waiting = game.status === "waiting" || !opponent;
  const primaryId = waiting ? creator : opponent;
  /** The other side — usually you. Empty while a challenge is still waiting. */
  const secondaryId = waiting ? "" : creator;

  const primaryName = nameFor(primaryId);
  const isVsComputer = primaryId === AI_PLAYER_ID;
  /** The bot's strength — absent on bare index entries, where the portrait
      falls back to the generic face rather than guessing. */
  const botLevel = "aiDifficulty" in game ? game.aiDifficulty : undefined;
  const secondaryName = secondaryId ? nameFor(secondaryId) : "";
  /** Which side the row's primary player sat on. */
  const primaryIsWhite = primaryId === creator;

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

  /** Your colour in this game, as a tiny disc beside your name. */
  const myColorIsWhite = isCreatorMe ? true : isOpponentMe ? false : null;
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
      {/* Who: the OPPONENT leads the row, with their real picture (or their
          initial — never random glyphs) at a size you can actually see. A bot
          opponent wears its painted portrait instead of a silhouette. */}
      {isVsComputer ? (
        <BotAvatar level={botLevel} size="md" />
      ) : (
        <PlayerAvatar name={primaryName} avatarUrl={players?.[primaryId]?.avatarUrl} size="md" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {primaryName}
          </span>
          {/* The played colour as a tiny disc right after the name. */}
          <span
            className={cn(
              "h-2.5 w-2.5 shrink-0 rounded-full border border-piece-outline/30",
              primaryIsWhite ? "bg-piece-light" : "bg-piece-dark",
            )}
            title={`Played ${primaryIsWhite ? "White" : "Black"}`}
          />
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-2xs text-muted-foreground">
          {waiting ? (
            <span>waiting for an opponent</span>
          ) : (
            <>
              {isVsComputer ? (
                <Bot className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <User className="h-3 w-3 shrink-0" aria-hidden />
              )}
              <span className="truncate">vs {secondaryName}</span>
              {myColorIsWhite !== null && (
                <span
                  className={cn(
                    "shrink-0 rounded bg-secondary/70 px-1 font-mono text-2xs tabular-nums",
                  )}
                  title={`You played ${myColorIsWhite ? "White" : "Black"}`}
                >
                  {myColorIsWhite ? "W" : "B"}
                </span>
              )}
            </>
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
