import { cn } from "@/lib/utils";

/**
 * A row of numbers about a player.
 *
 * The 5-up (games/wins/losses/draws/win rate) and the 3-up (peak/streak/best)
 * were written out twice, byte for byte, in `app/profile/page.tsx` and
 * `app/players/[username]/page.tsx` — including the `gap-px` over a `bg-border`
 * grid that draws the hairlines between tiles.
 */

/** Column shapes, spelled out because Tailwind can't scan a computed class. */
const LAYOUTS = {
  /** Five tiles: two per row on a phone, a single row from `sm` up. */
  five: "grid-cols-2 sm:grid-cols-5",
  three: "grid-cols-3",
} as const;

export interface StatTile {
  label: string;
  /** Already formatted, including the em dash for "no data yet". */
  value: string;
  /** Colours the number where its sign is the point (a streak). */
  tone?: "default" | "positive" | "negative";
}

export function StatTiles({
  tiles,
  layout,
  size = "md",
  className,
}: {
  tiles: StatTile[];
  layout: keyof typeof LAYOUTS;
  /** `sm` for a secondary row sitting under a primary one. */
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={cn(
        /* The 1px gaps show the border colour through, so the dividers are the
           background rather than a border on each tile — no doubled lines. */
        "grid gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60",
        LAYOUTS[layout],
        className,
      )}
    >
      {tiles.map((t) => (
        <div key={t.label} className="bg-card/50 px-4 py-4">
          <p
            className={cn(
              "font-mono font-bold tabular-nums",
              size === "sm" ? "text-lg" : "text-xl",
              t.tone === "positive" && "text-positive",
              t.tone === "negative" && "text-negative",
              (!t.tone || t.tone === "default") && "text-foreground",
            )}
          >
            {t.value}
          </p>
          <p className="mt-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t.label}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * A streak as `3W` / `2L`.
 *
 * Both pages rendered this as `+3` / `-3`, directly under "Peak rating" and one
 * tile away from a rating delta — so a signed monospace number was doing double
 * duty as "won three in a row" and "gained three rating points". The letter says
 * which, and drops the sign that was carrying the meaning.
 */
export function formatStreak(streak: number): StatTile {
  return {
    label: "Streak",
    value: streak === 0 ? "—" : `${Math.abs(streak)}${streak > 0 ? "W" : "L"}`,
    tone: streak > 0 ? "positive" : streak < 0 ? "negative" : "default",
  };
}
