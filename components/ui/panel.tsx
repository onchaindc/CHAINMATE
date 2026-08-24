import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The bordered surface a list of rows sits on.
 *
 * Five pages had written `overflow-hidden rounded-lg border border-border/70
 * bg-card/50` out by hand, which is why `Card` — the component that ought to be
 * this — is used by only two pages: the two idioms drifted (`rounded-xl`, a
 * solid `bg-card`, a shadow, no clipping) until neither was an instance of the
 * other. This is the list surface, named, so "the pages share a scale" is true
 * of surfaces and not only of type.
 */
export function Panel({
  children,
  tone = "default",
  clip = true,
  className,
}: {
  children: ReactNode;
  /** `accent` for the panel the page is steering you towards. */
  tone?: "default" | "accent";
  /**
   * Clips content to the rounded corners. On by default, and wanted almost
   * everywhere — but `overflow-hidden` makes an element a scroll container, and
   * `position: sticky` resolves against its nearest scrolling ancestor. So a
   * panel wrapping a table with a sticky header must pass `clip={false}`, or the
   * header sticks to a box that never scrolls and therefore never moves.
   */
  clip?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/50",
        tone === "accent" ? "border-primary/25" : "border-border/70",
        clip && "overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}
