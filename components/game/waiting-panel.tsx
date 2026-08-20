"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The pre-game panel for the player who opened the board.
 *
 * An open game is shared by link, so it hands you one to copy. A direct
 * challenge is addressed to one player — nobody else can accept it — so there is
 * no link to share, only their answer to wait for.
 */
export function WaitingPanel({
  gameId,
  local,
  challenge,
}: {
  gameId: string;
  local?: boolean;
  challenge?: boolean;
}) {
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
    <div className="rounded-lg border border-border/70 bg-card/50 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
          {challenge ? (
            <Swords className="h-4 w-4 text-primary" aria-hidden />
          ) : (
            <Link2 className="h-4 w-4 text-primary" aria-hidden />
          )}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            {challenge
              ? "Challenge sent"
              : local
                ? "Local game — this browser only"
                : "Game created — invite your opponent"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {challenge
              ? "They've been notified wherever they are in ChainMate. The board starts the moment they accept."
              : local
                ? "Open the link in another tab or browser on this machine to play Black."
                : "Send this link to a friend — they join as Black from any device, no account needed."}
          </p>
        </div>
      </div>

      {!challenge && (
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
      )}

      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex h-1.5 w-1.5">
          <span
            aria-hidden
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60"
          />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        {challenge
          ? "Waiting for your opponent to accept…"
          : "Waiting for your opponent to join…"}
      </p>
    </div>
  );
}
