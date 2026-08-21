"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { pieceRenderer } from "@/components/game/piece-sets";
import { cn } from "@/lib/utils";
import {
  BOARD_THEMES,
  PIECE_SETS,
  type BoardThemeId,
  type PieceSetId,
} from "@/lib/board-prefs";

interface BoardSettingsProps {
  boardTheme: BoardThemeId;
  pieceSet: PieceSetId;
  onBoardTheme: (id: BoardThemeId) => void;
  onPieceSet: (id: PieceSetId) => void;
}

/**
 * Board appearance picker. Sits with the board controls rather than in a
 * settings page, because the only useful way to judge a board is to see the
 * one you are playing on change under the choice.
 */
export function BoardSettings({
  boardTheme,
  pieceSet,
  onBoardTheme,
  onPieceSet,
}: BoardSettingsProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Board appearance"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground",
          open && "bg-secondary/50 text-foreground",
        )}
      >
        <Palette className="h-3.5 w-3.5" aria-hidden />
        Board
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-60 overflow-hidden rounded-lg border border-border/70 bg-popover/95 shadow-elevation-3 backdrop-blur">
          <div className="px-3 pb-2 pt-2.5">
            <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Board
            </p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {BOARD_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => onBoardTheme(theme.id)}
                  aria-pressed={boardTheme === theme.id}
                  title={theme.label}
                  className={cn(
                    "group flex flex-col items-center gap-1 rounded-md p-1 transition-colors",
                    boardTheme === theme.id ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                >
                  {/* Four squares in the theme's own colours — a board in
                      miniature, so the choice is judged by eye not by name. */}
                  <span
                    className={cn(
                      "grid h-7 w-7 grid-cols-2 overflow-hidden rounded ring-1",
                      boardTheme === theme.id ? "ring-primary/70" : "ring-border/70",
                    )}
                    aria-hidden
                  >
                    <span style={{ backgroundColor: `hsl(${theme.swatch.light})` }} />
                    <span style={{ backgroundColor: `hsl(${theme.swatch.dark})` }} />
                    <span style={{ backgroundColor: `hsl(${theme.swatch.dark})` }} />
                    <span style={{ backgroundColor: `hsl(${theme.swatch.light})` }} />
                  </span>
                  <span className="text-2xs text-muted-foreground group-hover:text-foreground">
                    {theme.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-border/60 px-3 pb-2.5 pt-2">
            <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Pieces
            </p>
            <div className="mt-1.5 space-y-1">
              {PIECE_SETS.map((set) => {
                const King = pieceRenderer(set.id, "w", "k");
                const Knight = pieceRenderer(set.id, "b", "n");
                return (
                  <button
                    key={set.id}
                    type="button"
                    onClick={() => onPieceSet(set.id)}
                    aria-pressed={pieceSet === set.id}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      pieceSet === set.id ? "bg-secondary" : "hover:bg-secondary/50",
                    )}
                  >
                    <span
                      className="flex h-7 w-12 shrink-0 items-center justify-center gap-0.5 rounded"
                      style={{ backgroundColor: "hsl(var(--board-dark))" }}
                      aria-hidden
                    >
                      <span className="h-6 w-6">{King ? <King /> : null}</span>
                      <span className="h-6 w-6">{Knight ? <Knight /> : null}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">
                        {set.label}
                      </span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {set.hint}
                      </span>
                    </span>
                    {pieceSet === set.id && (
                      <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
