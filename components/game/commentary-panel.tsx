"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AnalysisStatus } from "@/hooks/use-ai-commentary";
import type { CommentaryEntry } from "@/lib/types";

interface CommentaryPanelProps {
  entries: CommentaryEntry[];
  aiInsight?: string | null;
  aiStatus?: AnalysisStatus | null;
  aiEnabled?: boolean;
  aiHint?: string | null;
  onRetry?: () => void;
}

export function CommentaryPanel({
  entries,
  aiInsight,
  aiStatus,
  aiEnabled,
  aiHint,
  onRetry,
}: CommentaryPanelProps) {
  const statusLabel = aiStatus === "analyzing" ? "analyzing" : aiStatus === "ready" ? "ready" : aiEnabled ? "LLM enhanced" : "engine";

  return (
    <div className="border-t border-border/60">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <img src="/logo-mark.svg" alt="" className="h-4 w-4" />
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Analysis
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          <span
            className={cn(
              "h-1 w-1 rounded-full",
              aiStatus === "analyzing"
                ? "animate-pulse-soft bg-primary"
                : aiEnabled
                  ? "bg-primary"
                  : "bg-muted-foreground/50",
            )}
            aria-hidden
          />
          {statusLabel}
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
                <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                  {entry.side}
                </span>
                <Badge variant="secondary" className="ml-auto px-1.5 py-0 text-2xs">
                  {entry.source === "chain" ? "chain" : "engine"}
                </Badge>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-foreground/85">{entry.text}</p>
            </div>
          ))
        )}

        {aiEnabled && aiStatus === "analyzing" && (
          <div className="flex items-center gap-2 px-1 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <span className="dots" aria-hidden />
            Analyzing position
          </div>
        )}

        {aiEnabled && aiStatus === "ready" && aiInsight && (
          <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <img src="/logo-mark.svg" alt="" className="h-3.5 w-3.5" />
              <span className="text-2xs font-semibold uppercase tracking-wider text-primary">
                LLM insight
              </span>
              <Badge variant="gold" className="ml-auto px-1.5 py-0 text-2xs">
                ready
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">{aiInsight}</p>
          </div>
        )}

        {aiEnabled && aiStatus === "failed" && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-secondary/20 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Analysis failed
              </p>
              <p className="text-2xs text-muted-foreground">
                The position could not be analyzed right now.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={onRetry} className="shrink-0">
              Retry
            </Button>
          </div>
        )}

        {aiEnabled && aiStatus === "unavailable" && (
          <p className="px-1 text-2xs text-muted-foreground/70">
            Analysis unavailable for this move.
          </p>
        )}

        {aiHint && (
          <p className="px-1 pt-1 text-2xs text-muted-foreground/70">{aiHint}</p>
        )}
      </div>
    </div>
  );
}
