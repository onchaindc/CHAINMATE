"use client";

import { Chess } from "chess.js";
import { useMemo } from "react";
import { pieceRenderer } from "@/components/game/piece-sets";
import { PIECE_VALUES } from "@/lib/chess";
import { cn } from "@/lib/utils";
import type { PieceSetId } from "@/lib/board-prefs";

interface CaptureTrayProps {
  /** Position to read the material from — the live FEN, or a replay FEN. */
  fen: string;
  /** Whose tray this is: the pieces this side has taken off the board. */
  side: "white" | "black";
  pieceSet: PieceSetId;
  className?: string;
}

/** The full starting complement of one side, by chess.js piece letter. */
const START_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/** Smallest first, so a tray reads pawns → queen like every chess client. */
const ORDER = ["p", "n", "b", "r", "q"] as const;

/**
 * What one side has captured, plus the material lead when there is one.
 *
 * Derived from the position rather than from the move list, so it works
 * identically for a live game and for any replay ply without replaying moves
 * twice. The one artefact of reading a FEN is promotion: a promoted pawn is
 * missing from the board, so it shows in the opponent's tray as though it had
 * been captured. Every FEN-based client shows this, and the material lead —
 * which is what the number is for — stays correct either way.
 */
export function CaptureTray({ fen, side, pieceSet, className }: CaptureTrayProps) {
  const { captured, lead } = useMemo(() => {
    try {
      const chess = new Chess(fen);
      const mine = side === "white" ? "w" : "b";

      const counts: Record<string, number> = {};
      let myMaterial = 0;
      let theirMaterial = 0;
      for (const row of chess.board()) {
        for (const cell of row) {
          if (!cell) continue;
          if (cell.color === mine) myMaterial += PIECE_VALUES[cell.type] ?? 0;
          else {
            theirMaterial += PIECE_VALUES[cell.type] ?? 0;
            counts[cell.type] = (counts[cell.type] ?? 0) + 1;
          }
        }
      }

      // Their pieces that are no longer on the board — i.e. the ones this side
      // took. Clamped at zero because promotions can put more queens on the
      // board than the game started with.
      const taken = ORDER.flatMap((type) => {
        const missing = Math.max(0, (START_COUNTS[type] ?? 0) - (counts[type] ?? 0));
        return Array.from({ length: missing }, () => type);
      });

      return { captured: taken, lead: myMaterial - theirMaterial };
    } catch {
      return { captured: [] as string[], lead: 0 };
    }
  }, [fen, side]);

  if (captured.length === 0 && lead <= 0) {
    // Nothing taken and no lead: an empty strip would only add a dead row.
    return null;
  }

  const theirColor = side === "white" ? "b" : "w";

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <span className="flex min-w-0 flex-wrap items-center" aria-hidden>
        {captured.map((type, i) => {
          const Piece = pieceRenderer(pieceSet, theirColor, type);
          return (
            <span
              key={`${type}-${i}`}
              /* Overlapped slightly: a long tray of eight pawns would otherwise
                 push the rating and the clock out of a narrow card. */
              className="-ml-0.5 h-4 w-4 shrink-0 first:ml-0"
            >
              {Piece ? <Piece /> : null}
            </span>
          );
        })}
      </span>
      {lead > 0 && (
        <span className="shrink-0 font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
          +{lead}
        </span>
      )}
      <span className="sr-only">
        {captured.length > 0
          ? `Captured ${captured.length} ${captured.length === 1 ? "piece" : "pieces"}`
          : "No captures"}
        {lead > 0 ? `, ahead by ${lead}` : ""}
      </span>
    </div>
  );
}
