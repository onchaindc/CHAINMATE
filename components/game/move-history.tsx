"use client";

import { useEffect, useRef } from "react";
import { History } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MoveRecord } from "@/lib/types";

interface MoveHistoryProps {
  moves: MoveRecord[];
  currentPly?: number; // last ply index to highlight (optional)
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
    <div className="rounded-xl border border-border/70 bg-card/60">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <History className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Move history</h3>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {moves.length} ply
        </span>
      </div>

      {pairs.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          No moves yet — White opens the game.
        </p>
      ) : (
        <div className="max-h-56 overflow-y-auto px-2 py-2">
          <table className="w-full text-sm">
            <tbody>
              {pairs.map((pair, idx) => {
                const whitePly = pair.white ? pair.white.number - 1 : -1;
                const blackPly = pair.black ? pair.black.number - 1 : -1;
                return (
                  <tr
                    key={pair.number}
                    className={cn(
                      "rounded",
                      idx % 2 === 1 && "bg-secondary/40",
                    )}
                  >
                    <td className="w-10 py-1 pl-3 pr-1 font-mono text-xs text-muted-foreground">
                      {pair.number}.
                    </td>
                    <td className="py-1">
                      {pair.white ? (
                        <span
                          className={cn(
                            "inline-flex rounded px-1.5 py-0.5 font-mono",
                            whitePly === currentPly &&
                              "bg-primary/20 text-emerald-300",
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
                            "inline-flex rounded px-1.5 py-0.5 font-mono",
                            blackPly === currentPly &&
                              "bg-primary/20 text-emerald-300",
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
