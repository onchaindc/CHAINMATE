import { User } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The default stand-in for a player with no uploaded picture, on a chessboard
 * player card or anywhere a player's SIDE matters: a user silhouette on the
 * side-coloured disc. The disc colour carries the side (white/black piece
 * tokens); the silhouette is a person, not a king — the crown read as a rank
 * badge and users expected it to mean the winner.
 */
export function SideAvatar({
  side,
  className,
  iconClassName,
}: {
  side: "white" | "black";
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border",
        side === "white"
          ? "border-piece-outline/25 bg-piece-light text-piece-dark"
          : "border-piece-light/25 bg-piece-dark text-piece-light",
        className,
      )}
    >
      {/* Lucide's user silhouette — chess Unicode glyphs (♔/♚) have no glyphs
          in the default Windows UI fonts, so an icon font it is. */}
      <User className={iconClassName ?? "h-4 w-4"} aria-hidden />
    </span>
  );
}
