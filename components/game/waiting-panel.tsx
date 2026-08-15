"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WaitingPanel({ gameId, local }: { gameId: string; local?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");

  useEffect(() => {
    setUrl(`${window.location.origin}/game/${gameId}`);
  }, [gameId]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the input is still selectable
    }
  }, [url]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-accent/10 blur-2xl"
      />
      <div className="relative flex items-center gap-2">
        <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15">
          <span
            aria-hidden
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/20"
          />
          <Link2 className="relative h-4 w-4 text-accent" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            {local ? "Local game — this browser only" : "Game created — invite your opponent"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {local
              ? "Open the link in another tab or browser on this machine to play Black."
              : "Send this link to a friend — they join as Black from any device, no account needed."}
          </p>
        </div>
      </div>

      <div className="relative mt-3 flex gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Game link"
        />
        <Button size="sm" variant="secondary" onClick={copy} className="shrink-0">
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <p className="relative mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex h-2 w-2">
          <span
            aria-hidden
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60"
          />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        Waiting for your opponent to join…
      </p>
    </div>
  );
}
