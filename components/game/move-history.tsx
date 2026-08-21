"use client";

import { useEffect, useRef } from "react";
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

export function MoveHistory({ moves, currentPly, onSelectPly }: MoveHistoryProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Scroll the moves list internally only — never the page. A scrollIntoView
    // here would yank the whole window on mobile (the list sits below the
    // board), which is exactly the jump users saw after every move.
    const el = containerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [moves.length]);

  const pairs: { number: number; white?: MoveRecord; black?: MoveRecord }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({
      number: i / 2 + 1,
      white: moves[i],
      black: moves[i + 1],
    });
  }

  /** One move, as a button when the board can be moved to it and text when not. */
  const moveCell = (move: MoveRecord | undefined, ply: number) => {
    if (!move) return null;
    const current = ply === currentPly;
    const className = cn(
      "inline-block w-full rounded px-1.5 py-0.5 text-left font-mono tabular-nums transition-colors",
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
    <div className="border-t border-border/60">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Move history
        </span>
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">
          {onSelectPly && moves.length > 0 ? "click to review" : `${moves.length} ply`}
        </span>
      </div>

      {pairs.length === 0 ? (
        <p className="px-4 pb-4 text-center text-xs text-muted-foreground">
          No moves yet — White opens the game.
        </p>
      ) : (
        <div
          ref={containerRef}
          className="max-h-56 overflow-y-auto px-2 pb-2 lg:max-h-72"
        >
          <table className="w-full text-[13px]">
            <tbody>
              {pairs.map((pair, idx) => {
                const whitePly = pair.white ? pair.white.number - 1 : -1;
                const blackPly = pair.black ? pair.black.number - 1 : -1;
                return (
                  <tr key={pair.number} className={cn(idx % 2 === 1 && "bg-secondary/30")}>
                    <td className="w-9 py-0.5 pl-3 pr-1 font-mono text-xs tabular-nums text-muted-foreground">
                      {pair.number}.
                    </td>
                    <td className="w-[42%] py-0.5">
                      {pair.white ? (
                        moveCell(pair.white, whitePly)
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="w-[42%] py-0.5">{moveCell(pair.black, blackPly)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
