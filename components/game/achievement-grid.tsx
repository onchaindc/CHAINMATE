import { ACHIEVEMENTS } from "@/lib/achievements";
import { cn } from "@/lib/utils";
import type { PlayerStats } from "@/lib/types";

/** Grid of achievement badges — earned from real game data only. */
export function AchievementGrid({ stats }: { stats: PlayerStats }) {
  const earned = new Set((stats.achievements ?? []).map((a) => a.code));
  const earnedCount = earned.size;

  if (earnedCount === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-border/60 bg-card/30 px-6 py-10 text-center">
        <p className="text-sm font-medium text-foreground/85">No achievements yet</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Win games and hit milestones — first victory, streaks, rating
          milestones — to earn achievements.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/60 bg-border/50 sm:grid-cols-3">
      {ACHIEVEMENTS.map((a) => {
        const isEarned = earned.has(a.code);
        return (
          <div
            key={a.code}
            className={cn(
              "flex flex-col gap-1.5 bg-card/60 px-4 py-4",
              isEarned ? "text-foreground" : "text-muted-foreground/70",
            )}
            title={a.description}
          >
            <span className={cn("text-lg leading-none", isEarned && "drop-shadow-[0_0_6px_rgba(201,168,106,0.35)]")}>
              {a.icon}
            </span>
            <p className={cn("text-xs font-semibold", isEarned && "text-primary")}>{a.name}</p>
            <p className="text-[11px] leading-snug text-muted-foreground/90">{a.description}</p>
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider">
              {isEarned ? "Earned" : "Locked"}
            </p>
          </div>
        );
      })}
    </div>
  );
}
