import { User } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlayerAvatarProps {
  name: string;
  /** Public URL of an uploaded picture; falls back to the silhouette disc. */
  avatarUrl?: string | null;
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

const ICONS = {
  xs: "h-2.5 w-2.5",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-6 w-6",
} as const;

/**
 * The player's avatar: their uploaded picture when one exists, otherwise a
 * person-silhouette disc. The old fallback was the account's first letter,
 * which in lists of strangers read as random glyphs ("A", "O", "R"…) —
 * a letter means nothing; a person silhouette says "a player". Uploads are
 * normalized server-side to a single 256px webp, so the same file is sharp
 * at every size here.
 */
export function PlayerAvatar({ name, avatarUrl, size = "sm", className }: PlayerAvatarProps) {
  if (avatarUrl) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        className={cn(
          "shrink-0 select-none rounded-full border border-border/70 object-cover shadow-elevation-1",
          SIZES[size],
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        /* Theme-following surface: the previous zinc gradient and #EDE7DA text
           were dark-theme values, and turned into a dark blob on light paper. */
        "inline-flex select-none items-center justify-center rounded-full border border-border/70 bg-gradient-to-b from-secondary to-muted text-muted-foreground shadow-elevation-1",
        SIZES[size],
        className,
      )}
    >
      <User className={ICONS[size]} aria-hidden />
    </span>
  );
}
