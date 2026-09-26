"use client";

import { useEffect, useRef , memo } from "react";
import { cn } from "@/lib/utils";
import type { MoveRecord } from "@/lib/types";

interface MoveHistoryProps {
  moves: MoveRecord[];
  currentPly?: number;
  /**
   * Jump the board to the position after a move. Receives the 1-based ply count
   * *after* that move (the same number MoveRecord carries), so 1 is "after
   * White's first move". Omitted while a game is live — the board has to show
   * the position the players are actually playing.
   */
  onSelectPly?: (ply: number) => void;
}

/**
 * The move list, laid out HORIZONTALLY: one compact strip under the board
 * (full width of the board container, edges aligned), moves flowing left to
 * right as chips — "12. Nf3 Nc6" reads on one line instead of eating a
 * column. It scrolls vertically only when a very long game outgrows its
 * two-row cap, and never scrolls the page itself.
 */
export const MoveHistory = memo(function MoveHistory({ moves, currentPly, onSelectPly }: MoveHistoryProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Keep the newest move visible: walk to it whenever a move lands. */
  const tailRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    // Scroll the strip internally only — never the page. A scrollIntoView on
    // the window here would yank the whole page on mobile after every move.
    tailRef.current?.scrollIntoView({ block: "nearest", inline: "end", behavior: "smooth" });
  }, [moves.length]);

  /** One move, as a button when the board can be moved to it and text when not. */
  const moveCell = (move: MoveRecord) => {
    const ply = move.number - 1;
    const current = ply === currentPly;
    const className = cn(
      "shrink-0 rounded px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors",
      current && "bg-primary/15 font-semibold text-primary",
      onSelectPly && !current && "hover:bg-secondary hover:text-foreground",
    );

    if (!onSelectPly) {
      return <span className={className}>{move.san}</span>;
    }
    return (
      <button
        type="button"
        onClick={() => onSelectPly(move.number)}
        aria-current={current ? "true" : undefined}
        aria-label={`Go to move ${move.number}, ${move.san}`}
        className={className}
      >
        {move.san}
      </button>
    );
  };

  return (
    <div className="w-full">
      <div
        ref={containerRef}
        className="max-h-20 overflow-y-auto rounded-md bg-secondary/25 px-2.5 py-1.5"
      >
        {moves.length === 0 ? (
          <p className="py-0.5 text-center font-mono text-xs text-muted-foreground">
            No moves yet — White opens.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
            {moves.map((move, i) => (
              <span key={move.number} className="flex shrink-0 items-center gap-1">
                {/* The move number sits before White's move of each pair —
                    desktop only. On a phone the strip is narrow and the
                    ordinals cost more width than the SANs they label. */}
                {i % 2 === 0 && (
                  <span className="hidden shrink-0 font-mono text-2xs tabular-nums text-muted-foreground lg:inline">
                    {Math.floor(i / 2) + 1}.
                  </span>
                )}
                {moveCell(move)}
                {i === moves.length - 1 && (
                  <span ref={tailRef} aria-hidden className="w-px" />
                )}
              </span>
            ))}
          </div>
        )}
      </div>
      {onSelectPly && moves.length > 0 && (
        <p className="mt-0.5 hidden px-1 text-right font-mono text-2xs tabular-nums text-muted-foreground lg:block">
          click a move to review
        </p>
      )}
    </div>
  );
});
