import type { ReactNode } from "react";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { AvatarControls } from "@/components/profile/avatar-upload-card";
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
  avatarUrl,
  joinedAt,
  editableAvatar = false,
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
  /** The player's uploaded picture, when one exists. */
  avatarUrl?: string | null;
  /** Unix ms the account joined — shown as a small "Joined" line. */
  joinedAt?: number | string | null;
  /** Show the camera/remove controls on the avatar (own profile only). */
  editableAvatar?: boolean;
  className?: string;
}) {
  const joined =
    joinedAt
      ? new Date(joinedAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
        })
      : null;
  return (
    <div
      className={cn(
        "relative flex flex-wrap items-center gap-x-5 gap-y-4 animate-fade-in-up",
        className,
      )}
    >
      {editableAvatar ? (
        <AvatarControls name={name} avatarUrl={avatarUrl} />
      ) : (
        <PlayerAvatar name={name} avatarUrl={avatarUrl} size="lg" />
      )}

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
        {joined && (
          <p className="mt-1 text-2xs text-muted-foreground">Joined {joined}</p>
        )}
      </div>

      {/* Actions pin to the card's top-right corner (absolute), so they
          hold their position on phones where the name/rating rows wrap —
          the gear used to slide under the username there. */}
      {actions && (
        <div className="absolute right-0 top-0 flex items-center gap-2">{actions}</div>
      )}

      {/* `ml-auto` on the rating chip keeps it at the row's end; with the
          actions pinned absolutely it owns the whole right side. */}
      {rating !== null && rating !== undefined && (
        /* The rating as a small anchored chip: label on top, number and
           delta centred beneath. The old floating text block had the
           number left of its caption's edge and read as misaligned — a
           bordered chip with internal centre alignment can't drift. */
        <div className="ml-auto rounded-xl border border-border/60 bg-card/60 px-3.5 py-2 text-center shadow-elevation-1">
          <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Rating
          </p>
          <div className="mt-0.5 flex items-baseline justify-center gap-1.5">
            <p className="font-mono text-2xl font-bold leading-none tabular-nums text-primary">
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
