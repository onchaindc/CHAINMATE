"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { MoveRecord } from "@/lib/types";

interface MoveHistoryProps {
  moves: MoveRecord[];
  currentPly?: number;
}

export function MoveHistory({ moves, currentPly }: MoveHistoryProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [moves.length]);

  const pairs: { number: number; white?: MoveRecord; black?: MoveRecord }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({
      number: i / 2 + 1,
      white: moves[i],
      black: moves[i + 1],
    });
  }

  return (
    <div className="border-t border-border/60">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Move history
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {moves.length} ply
        </span>
      </div>

      {pairs.length === 0 ? (
        <p className="px-4 pb-4 text-center text-xs text-muted-foreground">
          No moves yet — White opens the game.
        </p>
      ) : (
        <div className="max-h-56 overflow-y-auto px-2 pb-2">
          <table className="w-full text-[13px]">
            <tbody>
              {pairs.map((pair, idx) => {
                const whitePly = pair.white ? pair.white.number - 1 : -1;
                const blackPly = pair.black ? pair.black.number - 1 : -1;
                return (
                  <tr key={pair.number} className={cn(idx % 2 === 1 && "bg-secondary/30")}>
                    <td className="w-9 py-1 pl-3 pr-1 font-mono text-xs tabular-nums text-muted-foreground">
                      {pair.number}.
                    </td>
                    <td className="py-1">
                      {pair.white ? (
                        <span
                          className={cn(
                            "inline-block rounded px-1.5 py-0.5 font-mono tabular-nums",
                            whitePly === currentPly && "bg-primary/15 text-primary",
                          )}
                        >
                          {pair.white.san}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="py-1">
                      {pair.black ? (
                        <span
                          className={cn(
                            "inline-block rounded px-1.5 py-0.5 font-mono tabular-nums",
                            blackPly === currentPly && "bg-primary/15 text-primary",
                          )}
                        >
                          {pair.black.san}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
