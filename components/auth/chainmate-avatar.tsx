import { cn } from "@/lib/utils";

/**
 * The ChainMate official account's face: the brand mark on a primary-tinted
 * disc. The official account is the PLATFORM, not a user — it has no profile
 * row, no profile page, and deliberately no initials silhouette (a silhouette
 * would render it as an anonymous guest). Everywhere it appears — chat
 * threads, notification rows — it renders as this disc, and nothing that
 * shows it links to a profile.
 */
export function ChainMateAvatar({
  size = "sm",
  className,
}: {
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const SIZES = {
    xs: "h-5 w-5",
    sm: "h-7 w-7",
    md: "h-9 w-9",
    lg: "h-14 w-14",
  } as const;
  const ICONS = {
    xs: "h-3 w-3",
    sm: "h-4 w-4",
    md: "h-5 w-5",
    lg: "h-8 w-8",
  } as const;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full border border-primary/30 bg-primary/10 shadow-elevation-1",
        SIZES[size],
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-mark.svg" alt="" className={ICONS[size]} />
    </span>
  );
}
