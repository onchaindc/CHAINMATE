import { cn } from "@/lib/utils";

interface PlayerAvatarProps {
  name: string;
  /** Public URL of an uploaded picture; falls back to the initial. */
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

/**
 * The player's avatar: their uploaded picture when one exists, otherwise the
 * compact initial disc. Uploads are normalized server-side to a single
 * 256px webp, so the same file is sharp at every size here — no giant
 * originals squashed into 28px, which is where avatar blur comes from.
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
