"use client";

import { Bot, Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CommentaryEntry } from "@/lib/types";

interface CommentaryPanelProps {
  entries: CommentaryEntry[];
  aiInsight?: string | null;
  aiLoading?: boolean;
  aiEnabled?: boolean;
  aiHint?: string | null;
  busy?: boolean;
}

export function CommentaryPanel({
  entries,
  aiInsight,
  aiLoading,
  aiEnabled,
  aiHint,
}: CommentaryPanelProps) {
  return (
    <div className="flex flex-col rounded-xl border border-border/70 bg-card/60">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <Sparkles className="h-4 w-4 text-accent" aria-hidden />
        <h3 className="text-sm font-semibold">AI commentary</h3>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {aiEnabled ? "LLM enhanced" : "rule engine"}
        </span>
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <p className="px-1 py-4 text-center text-sm text-muted-foreground">
            The AI commentator is ready — make a move to start the analysis.
          </p>
        ) : (
          entries.map((entry, i) => (
            <div
              key={i}
              className={cn(
                "rounded-lg border px-3 py-2",
                entry.source === "chain"
                  ? "border-border/60 bg-secondary/30"
                  : "border-accent/30 bg-accent/5",
              )}
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant={entry.source === "chain" ? "secondary" : "gold"}
                  className="gap-1 px-1.5 py-0 text-[10px]"
                >
                  {entry.source === "chain" ? (
                    <>
                      <Bot className="h-3 w-3" aria-hidden />
                      chain
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3 w-3" aria-hidden />
                      AI
                    </>
                  )}
                </Badge>
                {entry.move && (
                  <span className="font-mono text-xs font-semibold text-emerald-300">
                    {entry.move}
                  </span>
                )}
                <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {entry.side}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-foreground/85">
                {entry.text}
              </p>
            </div>
          ))
        )}

        {aiEnabled && aiLoading && (
          <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />
            The LLM is analysing the latest move…
          </div>
        )}

        {aiEnabled && aiInsight && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
            <div className="flex items-center gap-2">
              <Badge variant="gold" className="gap-1 px-1.5 py-0 text-[10px]">
                <Sparkles className="h-3 w-3" aria-hidden />
                AI insight
              </Badge>
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
