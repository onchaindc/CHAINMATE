import type { ReactNode } from "react";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { cn } from "@/lib/utils";

/**
 * Who a player is, at the top of a profile.
 *
 * `app/profile/page.tsx` and `app/players/[username]/page.tsx` had each written
 * this out: same avatar, same flag, same pill badges, same right-aligned rating
 * block — and both at `text-2xl` with no eyebrow, which is a step below the
 * `PageHeader` scale every other page opens with. So the two pages that are
 * *most* about a person had the quietest headings in the app.
 *
 * One component, on the PageHeader scale, with slots for the parts that genuinely
 * differ: the badges (Provisional here, "you" there) and the actions (the public
 * page's add-friend and challenge buttons).
 */
export function ProfileHeader({
  name,
  eyebrow,
  country,
  rating,
  ratingDelta,
  description,
  isGuest,
  badges,
  actions,
  className,
}: {
  name: string;
  /** Small uppercase label above the name ("Your profile", "Player"). */
  eyebrow?: string;
  country?: string | null;
  /** Null only while stats are still loading, or for a player who has none. */
  rating?: number | null;
  /**
   * Change from the player's most recent rated game. Shown beside the rating,
   * because "1512" answers a different question than "1512, up 12 last game".
   */
  ratingDelta?: number | null;
  description?: ReactNode;
  isGuest?: boolean;
  /** Extra pills after the guest/account one — use `ProfileBadge`. */
  badges?: ReactNode;
  /** Buttons in the right-hand cluster, before the rating block. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "animate-fade-in-up flex flex-wrap items-center gap-x-5 gap-y-4",
        className,
      )}
    >
      <PlayerAvatar name={name} size="lg" />

      <div className="min-w-0">
        {eyebrow && (
          <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1.5", eyebrow && "mt-1.5")}>
          <CountryFlag code={country ?? undefined} className="h-4 w-6" />
          <h1 className="font-display truncate text-3xl font-bold tracking-tight">
            {name}
          </h1>
          <ProfileBadge tone={isGuest ? "muted" : "primary"}>
            {isGuest ? "Guest" : "Account"}
          </ProfileBadge>
          {badges}
        </div>
        {description && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>

      {/* `ml-auto` on the cluster rather than on the rating block, so a page with
          actions keeps them beside the rating instead of pushing it off the row. */}
      {(actions || rating !== null) && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {actions}
          {rating !== null && rating !== undefined && (
            <div className="text-right">
              <div className="flex items-baseline justify-end gap-1.5">
                <p className="font-mono text-2xl font-bold tabular-nums text-primary">
                  {rating}
                </p>
                {ratingDelta !== null && ratingDelta !== undefined && ratingDelta !== 0 && (
                  <p
                    className={cn(
                      "font-mono text-xs font-semibold tabular-nums",
                      ratingDelta > 0 ? "text-positive" : "text-negative",
                    )}
                  >
                    {ratingDelta > 0 ? `+${ratingDelta}` : ratingDelta}
                  </p>
                )}
              </div>
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                ELO rating
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The small uppercase pill used beside a player's name. */
export function ProfileBadge({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "primary";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider",
        tone === "primary"
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border/70 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
