"use client";

import { Crown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CountryFlag } from "@/components/ui/country-flag";
import { cn } from "@/lib/utils";
import { AI_PLAYER_ID, type PlayerSide } from "@/lib/types";

interface PlayerCardProps {
  side: PlayerSide;
  playerId: string;
  isYou: boolean;
  isWinner: boolean;
  isTurn: boolean;
  waiting?: boolean;
  /** Display name (username when known, otherwise the short player id). */
  name?: string;
  /** ISO country code — renders the player's flag next to their name. */
  country?: string;
  /** Current ELO rating when known (real server data). */
  rating?: number | null;
  /** Formatted clock ("08:42") when the game has a time control. */
  clock?: string | null;
  clockLow?: boolean;
  /** Whether the side to move is in check (shown on their card). */
  inCheck?: boolean;
  /** The pieces this player has captured — <CaptureTray /> from the caller. */
  captures?: React.ReactNode;
}

export function PlayerCard({
  side,
  playerId,
  isYou,
  isWinner,
  isTurn,
  waiting,
  name,
  country,
  rating,
  clock,
  clockLow,
  inCheck,
  captures,
}: PlayerCardProps) {
  const isAi = playerId === AI_PLAYER_ID;
  const displayName = name ?? (isAi ? "ChainMate AI" : "Guest");
  const active = isTurn && !waiting;

  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border px-3 py-2 transition-colors",
        active ? "border-primary/45 bg-primary/[0.07]" : "border-border/60 bg-card/40",
        isWinner && "border-primary/50 bg-accent/5",
      )}
    >
      {/* Whose move it is, said in the layout itself rather than only in words:
          a gold rail down the edge of the card belonging to the side to move.
          It reads instantly from across a room, which is the entire job of a
          turn indicator during a game with a clock running. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[3px] transition-colors",
          active ? (clockLow ? "bg-negative" : "bg-primary") : "bg-transparent",
        )}
      />

      <div className="flex min-w-0 items-center gap-2.5">
        {active && (
          /* The rail above is decorative, so the turn still has to be said out
             loud for anyone not looking at the layout. */
          <span className="sr-only">{side === "white" ? "White" : "Black"} to move</span>
        )}
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
            /* The side's own colours, taken from the piece tokens so the disc
               matches the pieces on the board in either UI theme. These were
               hardcoded zinc, which turned both discs into grey blobs on a
               light background. */
            side === "white"
              ? "border-piece-outline/25 bg-piece-light text-piece-dark"
              : "border-piece-light/25 bg-piece-dark text-piece-light",
          )}
          aria-hidden
        >
          {/* A lucide crown, not a Unicode king (♔/♚): the chess glyphs are
              absent from the default Windows UI fonts, so this disc rendered
              an empty box on desktop. The disc colour carries the side. */}
          <Crown className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            <CountryFlag code={country} />
            <span className="truncate capitalize">{displayName}</span>
            {isYou && (
              <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
                you
              </Badge>
            )}
            {isWinner && (
              <Badge variant="gold" className="gap-1 px-1.5 py-0 text-2xs">
                <Crown className="h-3 w-3" aria-hidden />
                winner
              </Badge>
            )}
          </p>
          <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
            {rating !== null && rating !== undefined && (
              <span className="shrink-0 font-mono tabular-nums text-primary">{rating}</span>
            )}
            {/* Captures take the place of the status line once there are any —
                two rows of small print under one name is noise, and material
                is the more useful of the two mid-game. */}
            {captures ?? null}
            <span className="truncate">
              {isAi ? "Computer" : waiting ? "Waiting…" : name ? "" : "Guest"}
            </span>
            {inCheck && active && (
              <span className="shrink-0 font-semibold uppercase tracking-wide text-negative">
                check
              </span>
            )}
          </div>
        </div>
      </div>

      {clock !== null && clock !== undefined && (
        <span
          className={cn(
            /* The clock is the largest number on the screen for a reason: under
               time pressure it is the only thing a player looks at. Tabular
               figures so the digits never reflow as they count down. */
            "shrink-0 rounded-md border px-3 py-1 text-center font-mono text-2xl font-semibold leading-tight tabular-nums transition-colors duration-300 sm:text-[1.75rem]",
            clockLow
              ? "border-negative/50 bg-negative/10 text-negative"
              : active
                ? "border-primary/50 bg-primary/[0.10] text-foreground"
                : "border-border/60 bg-secondary/25 text-muted-foreground",
          )}
          aria-label={`${side === "white" ? "White" : "Black"} clock`}
        >
          {clock}
        </span>
      )}
    </div>
  );
}
