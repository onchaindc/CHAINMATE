import type { ComponentType, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The heading block every list page opens with: a small uppercase eyebrow, a
 * display-serif title, and a line of explanation.
 *
 * This markup was copy-pasted across Games, Leaderboard, Watch, Profile and
 * Join, and had already drifted — different top padding, different eyebrow
 * tracking, `mt-2` in one place and `mt-3` in another. Pulling it into one
 * component is what makes "the pages share a scale" true rather than
 * approximately true.
 */
export function PageHeader({
  eyebrow,
  eyebrowIcon: EyebrowIcon,
  title,
  description,
  actions,
  align = "start",
  className,
}: {
  /** Small uppercase label above the title ("Rankings", "Your record"). */
  eyebrow?: string;
  /**
   * Icon set inline before the eyebrow text. Here rather than in the caller so
   * the size and gap can't drift — Auth had it at its own geometry.
   */
  eyebrowIcon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  /** Buttons aligned to the title on wide screens, stacked under it on narrow. */
  actions?: ReactNode;
  /** Narrow single-purpose pages (Create, Join) centre their heading. */
  align?: "start" | "center";
  className?: string;
}) {
  const centered = align === "center";
  return (
    <div className={cn("animate-fade-in-up", centered && "text-center", className)}>
      <div
        className={cn(
          "flex flex-wrap items-end gap-x-6 gap-y-4",
          centered ? "justify-center" : "justify-between",
        )}
      >
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              {EyebrowIcon && (
                <EyebrowIcon className="mr-1.5 inline h-3.5 w-3.5 align-[-0.2em]" />
              )}
              {eyebrow}
            </p>
          )}
          <h1
            className={cn(
              "font-display text-3xl font-bold tracking-tight text-balance",
              eyebrow && "mt-3",
            )}
          >
            {title}
          </h1>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p
          className={cn(
            "mt-2 text-sm leading-relaxed text-muted-foreground",
            centered ? "mx-auto max-w-sm mt-3" : "max-w-2xl",
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}

/** The section label used above a group of rows inside a page. */
export function SectionLabel({
  children,
  live,
  className,
  aside,
}: {
  children: ReactNode;
  /** Adds the soft pulsing dot used for genuinely live data. */
  live?: boolean;
  className?: string;
  /** Secondary text right-aligned on the same baseline. */
  aside?: ReactNode;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <h2
        className={cn(
          "flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider",
          live ? "text-primary" : "text-muted-foreground",
        )}
      >
        {live && (
          <span
            className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary"
            aria-hidden
          />
        )}
        {children}
      </h2>
      {aside && <p className="text-2xs text-muted-foreground">{aside}</p>}
    </div>
  );
}

/**
 * The quiet "← back to …" line above a page heading. Every drill-in page
 * (a tournament, the host form) gets one so a deep link is never a trap —
 * one click returns to the list you came from.
 */
export function BackLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {children}
    </Link>
  );
}
