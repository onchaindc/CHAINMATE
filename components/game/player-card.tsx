"use client";

import { Bot, Crown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { SideAvatar } from "@/components/game/side-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { cn } from "@/lib/utils";
import { AI_BRAND_SHORT, AI_PLAYER_ID, type PlayerSide } from "@/lib/types";

interface PlayerCardProps {
  side: PlayerSide;
  playerId: string;
  isYou: boolean;
  isWinner: boolean;
  isTurn: boolean;
  waiting?: boolean;
  /** Display name (username when known, otherwise the short player id). */
  name?: string;
  /** Uploaded profile picture, when the player has one (else the initial). */
  avatarUrl?: string | null;
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
  avatarUrl,
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
        /* Flat card: no border, just a tinted surface that deepens when it
           is this side's move. The gold rail carries the turn signal, so a
           boxed outline everywhere is visual noise the eye must parse. */
        "relative flex items-center justify-between gap-3 overflow-hidden rounded-lg px-3 py-1.5 transition-colors",
        active ? "bg-primary/[0.09]" : "bg-secondary/25",
        isWinner && "bg-accent/10",
      )}
    >
      {/* Whose move it is, said in the layout itself rather than only in words:          a gold rail down the edge of the card belonging to the side to move.
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
        {/* The player's real face when they uploaded one; the side-coloured
            crown disc otherwise. Guests keep the disc — that is their look. */}
        {avatarUrl && !isAi ? (
          <PlayerAvatar name={displayName} avatarUrl={avatarUrl} size="md" />
        ) : isAi ? (
          /* The bot keeps its own mark — an engine, not a person. */
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
              side === "white"
                ? "border-piece-outline/25 bg-piece-light text-piece-dark"
                : "border-piece-light/25 bg-piece-dark text-piece-light",
            )}
            aria-hidden
          >
            <Bot className="h-4 w-4" />
          </span>
        ) : (
          /* Default player avatar: a user silhouette on the side-coloured
             disc. The old crown read as a rank badge ("why do they have a
             crown?") — a person silhouette says "a player". */
          <SideAvatar side={side} className="h-8 w-8" />
        )}
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
              {isAi ? AI_BRAND_SHORT : waiting ? "Waiting…" : name ? "" : "Guest"}
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
               figures so the digits never reflow as they count down. No box
               around it — a tinted pill for the running clock only, so the
               inactive side reads as quiet as the card around it. */
            "shrink-0 rounded-md px-2.5 py-0.5 text-center font-mono text-xl font-semibold leading-tight tabular-nums transition-colors duration-300 sm:text-2xl",
            clockLow
              ? "bg-negative/15 text-negative"
              : active
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground/80",
          )}
          aria-label={`${side === "white" ? "White" : "Black"} clock`}
        >
          {clock}
        </span>
      )}
    </div>
  );
}
