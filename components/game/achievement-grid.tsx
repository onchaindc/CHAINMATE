import { Award } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";
import { ACHIEVEMENTS } from "@/lib/achievements";
import { cn } from "@/lib/utils";
import type { PlayerStats } from "@/lib/types";

/** Grid of achievement badges — earned from real game data only. */
export function AchievementGrid({ stats }: { stats: PlayerStats }) {
  const earned = new Set((stats.achievements ?? []).map((a) => a.code));
  const earnedCount = earned.size;

  if (earnedCount === 0) {
    return (
      <Panel>
        <EmptyState
          icon={Award}
          title="No achievements yet"
          description="Earned achievements appear here."
          className="py-10"
        />
      </Panel>
    );
  }

  return (
    /* The same hairline treatment as the stat tiles above it (`gap-px` over the
       border colour): these two grids sit one under the other on the profile,
       and were drawing their dividers at two different opacities. */
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 sm:grid-cols-3">
      {ACHIEVEMENTS.map((a) => {
        const isEarned = earned.has(a.code);
        return (
          <div
            key={a.code}
            className={cn(
              "flex flex-col gap-1.5 bg-card/50 px-4 py-4",
              isEarned ? "text-foreground" : "text-muted-foreground/70",
            )}
            title={a.description}
          >
            <span className={cn("text-lg leading-none", isEarned && "drop-shadow-[0_0_6px_hsl(var(--primary)/0.35)]")}>
              {a.icon}
            </span>
            <p className={cn("text-xs font-semibold", isEarned && "text-primary")}>{a.name}</p>
            <p className="text-2xs leading-snug text-muted-foreground/90">{a.description}</p>
            <p className="mt-0.5 text-2xs font-semibold uppercase tracking-wider">
              {isEarned ? "Earned" : "Locked"}
            </p>
          </div>
        );
      })}
    </div>
  );
}
