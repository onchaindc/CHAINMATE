"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Play, Swords, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one-active-game gate popup.
 *
 * One board at a time is a rule of the app: every path that starts (or joins)
 * a game refuses while one is still running, and the refusal names the game
 * that is in the way. This dialog is the surface that refusal becomes — a
 * deliberate, modern interruption with one clear way forward (Resume your
 * game) and an honest way out (stay where you are), instead of a silent
 * redirect that reads as if the new game had opened.
 *
 * House dialog conventions, deliberately kept: the `scrim` token backdrop,
 * `animate-fade-in-up` entrance, centered on every screen, Escape to dismiss.
 */

export interface ActiveGameGateDialogProps {
  open: boolean;
  /** The running game the player should go back to. */
  activeGameId: string;
  /** One line of context — the action that was refused ("your rematch", "this challenge"). */
  attempted?: string;
  onClose: () => void;
}

export function ActiveGameGateDialog({
  open,
  activeGameId,
  attempted,
  onClose,
}: ActiveGameGateDialogProps) {
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="You already have a game in progress"
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="animate-fade-in-up w-full max-w-sm overflow-hidden rounded-xl border border-border/70 bg-card shadow-elevation-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Eyebrow strip — the brand mark the end-game modal uses, so a gate
            refusal reads as the same product speaking, not an OS alert. */}
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-primary/[0.06] px-5 py-3">
          <p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.18em] text-primary">
            <span
              className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary"
              aria-hidden
            />
            One game at a time
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-0.5 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex items-start gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/[0.08] text-primary"
              aria-hidden
            >
              <Swords className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold tracking-tight">
                You already have a game in progress
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {attempted
                  ? `We couldn't start ${attempted} because your other match is still running.`
                  : "Your other match is still running."}{" "}
                Finish it — resign it, or play it out — before starting a new one.
              </p>
            </div>
          </div>
        </div>

        <div className="flex gap-2.5 px-5 pb-5">
          <Button
            className="flex-1"
            onClick={() => {
              onClose();
              router.push(`/game/${activeGameId}`);
            }}
          >
            <Play aria-hidden />
            Resume your game
          </Button>
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Stay here
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A quiet inline variant of the same notice, for surfaces that already show
 * their own state (the lobby's play box) and only need the pill back.
 */
export function ActiveGameGatePill({
  activeGameId,
  className,
}: {
  activeGameId: string;
  className?: string;
}) {
  const router = useRouter();
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/[0.06] px-3.5 py-2.5",
        className,
      )}
    >
      <p className="text-xs text-muted-foreground">You already have a game in progress.</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => router.push(`/game/${activeGameId}`)}
      >
        <Play aria-hidden />
        Resume
      </Button>
    </div>
  );
}
