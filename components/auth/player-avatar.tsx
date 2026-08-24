import { cn } from "@/lib/utils";

interface PlayerAvatarProps {
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const SIZES = {
  /** Inside a pill, beside text. Added because a caller was overriding `sm`
      with three `!important` utilities to reach roughly this size. */
  xs: "h-5 w-5 text-2xs",
  sm: "h-7 w-7 text-2xs",
  md: "h-9 w-9 text-sm",
  lg: "h-14 w-14 text-xl",
} as const;

/** Compact initial-based avatar — no images, no external services. */
export function PlayerAvatar({ name, size = "sm", className }: PlayerAvatarProps) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        /* Theme-following surface: the previous zinc gradient and #EDE7DA text
           were dark-theme values, and turned into a dark blob on light paper. */
        "inline-flex select-none items-center justify-center rounded-full border border-border/70 bg-gradient-to-b from-secondary to-muted font-semibold text-secondary-foreground shadow-elevation-1",
        SIZES[size],
        className,
      )}
    >
      {initial}
    </span>
  );
}
