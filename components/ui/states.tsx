"use client";

import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The three states every data page needs, in one place.
 *
 * Each page had grown its own: three `h-11` pulse divs here, two there, an
 * error banner that was a bordered card on Leaderboard but a bare row on Games,
 * an empty state with a CTA on one page and a dead end on the next. Same states,
 * different answers — which reads as an unfinished app rather than a designed
 * one.
 */

/** Skeleton rows for a list that is still loading. */
export function LoadingRows({
  rows = 3,
  className,
  rowClassName,
}: {
  rows?: number;
  className?: string;
  /** Override the row height where the real rows aren't list-height (cards). */
  rowClassName?: string;
}) {
  return (
    <div className={cn("space-y-1 px-2 py-3", className)} aria-busy>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn(
            "h-11 animate-pulse rounded-md bg-secondary/60",
            rowClassName,
          )}
          /* Staggered so it reads as one list filling in rather than three bars
             blinking in lockstep. */
          style={{ animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * A list that has nothing in it — and, wherever possible, the one action that
 * would change that. An empty state without a way out is a dead end.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center px-6 py-16 text-center",
        className,
      )}
    >
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/50" aria-hidden />}
      <p className={cn("text-sm font-medium text-foreground/85", Icon && "mt-3")}>
        {title}
      </p>
      {description && (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && (
        <Link
          href={action.href}
          className={cn(buttonVariants({ size: "sm" }), "mt-5")}
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}

/**
 * Something failed. Shows what, and offers a retry when the caller has one —
 * a failed fetch the user cannot re-attempt is just a wall.
 */
export function ErrorNote({
  message,
  title,
  onRetry,
  className,
}: {
  message: string;
  /** Headline above the message, for a failure the user needs named ("Could
   *  not join"). Without one the message stands alone. */
  title?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5",
        className,
      )}
    >
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {title && (
          <p className="text-sm font-medium text-destructive">{title}</p>
        )}
        <p
          className={cn(
            "text-destructive",
            title ? "mt-0.5 text-xs leading-snug text-destructive/90" : "text-sm",
          )}
        >
          {message}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-destructive underline-offset-2 hover:underline"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}
