"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The app's one confirmation dialog — a focused, deliberate interruption for
 * actions whose consequences deserve a second look (leaving a paid
 * tournament, deleting an event, dispatching payouts).
 *
 * Deliberately NOT sprinkled everywhere: it exists for the small set of
 * destructive or money-adjacent actions the operator named. Low-stakes
 * clicks keep their instant feedback.
 *
 * Replaces the raw window.confirm() some actions used, which rendered as a
 * native sheet the wallet WebView could layer wrongly on Android and gave no
 * room to explain the forfeit rule in the same breath as the button.
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  /** The action button's label ("Leave tournament"). */
  confirmLabel: string;
  /** Destructive actions render the confirm button in red. */
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  className?: string;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  destructive,
  busy,
  onCancel,
  onConfirm,
  className,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={cn(
        "fixed inset-0 z-50 flex items-end justify-center bg-scrim backdrop-blur-sm sm:items-center sm:p-4",
        className,
      )}
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="animate-fade-in-up w-full rounded-t-xl border border-border/70 bg-card p-5 shadow-elevation-3 sm:max-w-sm sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            {destructive ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
            ) : null}
            {title}
          </p>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
            disabled={busy}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children && (
          <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
        )}
        <div className="mt-4 flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            className="flex-1"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
