"use client";

import { useState } from "react";
import { ChevronDown, Trophy } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { ACHIEVEMENTS } from "@/lib/achievements";
import { cn } from "@/lib/utils";
import type { PlayerStats } from "@/lib/types";

/**
 * Compact achievements card for the profile: a short strip of trophies with
 * an expand control that reveals the full shelf of every achievement, from
 * bronze to diamond. All badges are trophies tinted by tier, so the card
 * reads as a trophy shelf rather than a wall of text.
 */

const TIER_STYLES: Record<string, { earned: string; locked: string; label: string }> = {
  bronze: { earned: "text-[#cd7f32]", locked: "text-muted-foreground/40", label: "Bronze" },
  silver: { earned: "text-[#c0c0c0]", locked: "text-muted-foreground/40", label: "Silver" },
  gold: { earned: "text-[#f5b81d]", locked: "text-muted-foreground/40", label: "Gold" },
  diamond: { earned: "text-[#7dd3fc]", locked: "text-muted-foreground/40", label: "Diamond" },
};

function tierOf(code: string) {
  return TIER_STYLES[ACHIEVEMENTS.find((a) => a.code === code)?.tier ?? "bronze"];
}

export function AchievementGrid({ stats }: { stats: PlayerStats }) {
  const [expanded, setExpanded] = useState(false);
  const earnedSet = new Set((stats.achievements ?? []).map((a) => a.code));
  const earnedCount = earnedSet.size;
  const total = ACHIEVEMENTS.length;

  if (total === 0) return null;

  // Earned first so the collapsed strip leads with what the player has won.
  const ordered = [...ACHIEVEMENTS].sort(
    (a, b) => (earnedSet.has(a.code) ? 0 : 1) - (earnedSet.has(b.code) ? 0 : 1),
  );

  return (
    <Panel>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/30"
      >
        <Trophy aria-hidden className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 text-xs font-semibold">Achievements</span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {earnedCount}/{total}
        </span>
        <span className="ml-auto flex min-w-0 items-center justify-end gap-1 overflow-hidden">
          {/* Collapsed preview: the newest six, collapsing to +N more. */}
          {ordered.slice(0, 6).map((a) => {
            const isEarned = earnedSet.has(a.code);
            return (
              <span
                key={a.code}
                title={a.name}
                className={cn(
                  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
                  isEarned
                    ? cn("border-border/70 bg-card", tierOf(a.code).earned)
                    : "border-dashed border-border/40 text-muted-foreground/50",
                )}
              >
                <Trophy aria-hidden className="h-3 w-3" />
              </span>
            );
          })}
          {total > 6 && (
            <span className="shrink-0 text-2xs text-muted-foreground">+{total - 6}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-4 py-4">
          {earnedCount === 0 && (
            <p className="mb-3 text-2xs text-muted-foreground">
              Play rated games to win your first trophy.
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {ACHIEVEMENTS.map((a) => {
              const isEarned = earnedSet.has(a.code);
              const tier = tierOf(a.code);
              return (
                <div
                  key={a.code}
                  title={`${a.name}: ${a.description}`}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border px-1 py-2.5 text-center",
                    isEarned
                      ? "border-border/70 bg-card"
                      : "border-dashed border-border/40 bg-transparent",
                  )}
                >
                  <Trophy
                    aria-hidden
                    className={cn(
                      "h-5 w-5",
                      isEarned
                        ? cn(tier.earned, "drop-shadow-[0_0_5px_hsl(var(--primary)/0.3)]")
                        : tier.locked,
                    )}
                  />
                  <p
                    className={cn(
                      "w-full truncate text-2xs font-semibold",
                      isEarned ? "text-foreground" : "text-muted-foreground/60",
                    )}
                  >
                    {a.name}
                  </p>
                  <p className="text-2xs uppercase tracking-wider text-muted-foreground/70">
                    {tier.label}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}
