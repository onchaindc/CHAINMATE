import { cn } from "@/lib/utils";

interface PlayerAvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZES = {
  sm: "h-7 w-7 text-[11px]",
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
        "inline-flex select-none items-center justify-center rounded-full border border-border/70 bg-gradient-to-b from-zinc-700 to-zinc-800 font-semibold text-[#EDE7DA] shadow-sm",
        SIZES[size],
        className,
      )}
    >
      {initial}
    </span>
  );
}
