"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CommentaryEntry } from "@/lib/types";

interface CommentaryPanelProps {
  entries: CommentaryEntry[];
  aiInsight?: string | null;
  aiLoading?: boolean;
  aiEnabled?: boolean;
  aiHint?: string | null;
}

export function CommentaryPanel({
  entries,
  aiInsight,
  aiLoading,
  aiEnabled,
  aiHint,
}: CommentaryPanelProps) {
  return (
    <div className="border-t border-border/60">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <img src="/logo-mark.svg" alt="" className="h-4 w-4" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Analysis
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span
            className={cn("h-1 w-1 rounded-full", aiEnabled ? "bg-primary" : "bg-muted-foreground/50")}
            aria-hidden
          />
          {aiEnabled ? "LLM enhanced" : "engine"}
        </span>
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            The analyst is ready — make a move to start the annotations.
          </p>
        ) : (
          entries.map((entry, i) => (
            <div
              key={i}
              className="rounded-md border border-border/50 bg-secondary/20 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                {entry.move && (
                  <span className="font-mono text-xs font-semibold text-primary">
                    {entry.move}
                  </span>
                )}
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {entry.side}
                </span>
                <Badge variant="secondary" className="ml-auto px-1.5 py-0 text-[10px]">
                  {entry.source === "chain" ? "chain" : "engine"}
                </Badge>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-foreground/85">{entry.text}</p>
            </div>
          ))
        )}

        {aiEnabled && aiLoading && (
          <div className="flex items-center gap-2 px-1 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <span className="dots" aria-hidden />
            Analyzing position
          </div>
        )}

        {aiEnabled && aiInsight && (
          <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <img src="/logo-mark.svg" alt="" className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                LLM insight
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">{aiInsight}</p>
          </div>
        )}

        {aiHint && (
          <p className="px-1 pt-1 text-[11px] text-muted-foreground/70">{aiHint}</p>
        )}
      </div>
    </div>
  );
}
