import Link from "next/link";
import { SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import type { GameState, RatingChangeEntry } from "@/lib/types";
import { Sparkline, ratingSeries } from "@/components/ui/sparkline";

/**
 * The last few rated results as W/D/L squares.
 *
 * Written for the lobby sidebar and then left there, even though the profile —
 * the page actually about a player's record — showed totals and a game list with
 * nothing in between. Same data, and the profile had it in hand.
 */
export function RecentForm({
  history,
  games,
  playerId,
  streak,
  loading,
  showTrend = false,
  limit = 8,
  className,
}: {
  /** Newest first, as the server records it. Undefined while loading. */
  history: RatingChangeEntry[] | undefined;
  /** Recent games, to read the true result from. Deltas alone can't say. */
  games: GameState[] | undefined;
  playerId: string;
  /** Positive = winning streak. Shown as the section's aside when non-zero. */
  streak?: number;
  loading?: boolean;
  /** Adds the rating-history line under the squares. */
  showTrend?: boolean;
  limit?: number;
  className?: string;
}) {
  const form = recentForm(history, games, playerId, limit);
  /* The full history, not the `limit` slice — the squares are the last few
     results, but the line is the whole climb. */
  const series = showTrend ? ratingSeries(history ?? []) : [];

  return (
    <Panel clip={false} className={cn("animate-fade-in-up p-4", className)}>
      <SectionLabel
        aside={
          streak !== undefined && streak !== 0
            ? `${Math.abs(streak)} ${streak > 0 ? "win" : "loss"} streak`
            : undefined
        }
      >
        Recent form
      </SectionLabel>

      {loading ? (
        <div className="mt-3 h-7 animate-pulse rounded-md bg-secondary/60" />
      ) : form.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          No rated games yet — your first result shows up here.
        </p>
      ) : (
        <>
          <ol className="mt-3 flex flex-wrap gap-1.5">
            {form.map((f) => (
              <li key={f.gameId}>
                <Link
                  href={`/game/${f.gameId}?replay=1`}
                  title={`${f.change > 0 ? `+${f.change}` : f.change} rating`}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md text-2xs font-bold transition-transform hover:scale-110",
                    f.outcome === "W" && "bg-primary/15 text-primary",
                    f.outcome === "L" && "bg-negative/15 text-negative",
                    f.outcome === "D" && "bg-secondary text-muted-foreground",
                  )}
                >
                  {f.outcome}
                </Link>
              </li>
            ))}
          </ol>
          {series.length >= 2 && <Sparkline values={series} className="mt-3" />}
          <p className="mt-2.5 text-2xs text-muted-foreground">
            Newest first · tap a result to replay that game
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * Recent rated results, newest first.
 *
 * The outcome comes from the game, not from the sign of the rating change: you
 * can lose rating in a draw against a weaker player, and a draw shown as a loss
 * is simply wrong. The sign is only the fallback for a rated game whose record
 * didn't come back with this page.
 */
function recentForm(
  history: RatingChangeEntry[] | undefined,
  games: GameState[] | undefined,
  playerId: string,
  limit: number,
) {
  const byId = new Map((games ?? []).map((g) => [g.id, g]));
  return (history ?? []).slice(0, limit).map((h) => {
    const game = byId.get(h.gameId);
    const outcome = !game
      ? h.change > 0
        ? "W"
        : h.change < 0
          ? "L"
          : "D"
      : game.winner === playerId
        ? "W"
        : game.winner === ""
          ? "D"
          : "L";
    return { gameId: h.gameId, outcome, change: h.change } as const;
  });
}
