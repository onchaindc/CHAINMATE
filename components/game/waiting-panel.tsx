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
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15">
          <Link2 className="h-4 w-4 text-accent" aria-hidden />
        </span>
        <div>
          <h3 className="text-sm font-semibold">
            {local ? "Local game — this browser only" : "Game created — invite your opponent"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {local
              ? "This game lives on this device. Open the link in another tab or browser of this machine to play Black."
              : "Share this link. They join as Black with one click."}
          </p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
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

      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />
        Waiting for your opponent to join…
      </p>
    </div>
  );
}
