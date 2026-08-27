"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, Loader2 } from "lucide-react";
import { ChessBoard } from "@/components/game/chess-board";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { ErrorNote } from "@/components/ui/states";
import { useBoardPrefs } from "@/hooks/use-board-prefs";
import { getStore } from "@/lib/store";
import { AI_LEVELS, START_FEN, aiLevelFor, normalizeAiDifficulty, type AiDifficulty } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Solo — pick an opponent, press play.
 *
 * This used to be `/create?mode=ai`: the two-player setup form with one branch
 * flipped. Which meant the biggest button on the "Solo" screen was **Play
 * online — find a match**, the header offered to deploy a contract and share an
 * invite link, and the only decision that mattered sat fourth down a
 * nine-block column. The nav has always called Solo a destination; this is it
 * being one.
 *
 * There is exactly one control here. Everything else about a solo game — White,
 * unrated, untimed — is fixed, so it is stated once as a fact rather than
 * offered as five more things to configure.
 *
 * No `RequireProfile`: solo games live in the on-device store, so a guest can
 * play without an account.
 */

export default function SoloPage() {
  const router = useRouter();
  const { pieceSet } = useBoardPrefs();
  const [difficulty, setDifficulty] = useState<AiDifficulty>(normalizeAiDifficulty());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Preselected opponent, from `?level=` when a rematch sent us back here.
   *
   * Applied after mount, not in the `useState` initialiser. This page is
   * prerendered — `○ /solo` in the build output — so its HTML ships with the
   * default opponent already marked `aria-checked`. An initialiser that read the
   * query would disagree with that HTML on the first client render, and React
   * would report a hydration mismatch and flip the roster in front of the
   * player. One frame on the default costs less than that.
   *
   * Read off `window.location.search` rather than through `useSearchParams()`,
   * which would oblige this page to sit inside a Suspense boundary to stay
   * prerenderable. `normalizeAiDifficulty` already absorbs both a missing value
   * and the legacy `competitive` id, so there is nothing to validate here.
   */
  useEffect(() => {
    const level = new URLSearchParams(window.location.search).get("level");
    if (level) setDifficulty(normalizeAiDifficulty(level));
  }, []);

  const selected = aiLevelFor(difficulty);

  const play = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const game = await getStore("local").createAiGame(difficulty);
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the game");
      setBusy(false);
    }
  }, [router, difficulty]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-14 sm:px-6 lg:py-20">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start lg:gap-12">
        <div className="min-w-0">
          <PageHeader
            eyebrow="Solo"
            eyebrowIcon={Bot}
            title="Play the computer"
            description="Five engine levels, 600 to 2000. Unrated, untimed."
          />

          <Panel className="mt-8 animate-fade-in-up [animation-delay:80ms]">
            <div className="divide-y divide-border/50" role="radiogroup" aria-label="Opponent">
              {AI_LEVELS.map((level) => {
                const active = difficulty === level.id;
                return (
                  <button
                    key={level.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setDifficulty(level.id)}
                    className={cn(
                      "relative flex w-full items-baseline justify-between gap-4 px-4 py-3 text-left transition-colors",
                      active ? "bg-primary/[0.06]" : "hover:bg-secondary/40",
                    )}
                  >
                    {/* The selected row is marked by the row itself — a leading
                        bar and the name coming forward — rather than by a radio
                        disc. Five discs down the left edge is what made the old
                        list read as a form to fill in instead of a roster to
                        pick from. */}
                    {active && (
                      <span
                        className="absolute inset-y-0 left-0 w-0.5 bg-primary"
                        aria-hidden
                      />
                    )}
                    <span
                      className={cn(
                        "truncate text-sm transition-colors",
                        active
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {level.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-xs tabular-nums transition-colors",
                        active ? "text-primary" : "text-muted-foreground/70",
                      )}
                    >
                      {level.rating}
                    </span>
                  </button>
                );
              })}
            </div>
          </Panel>

          {/* Only the chosen opponent's blurb, on a reserved line.
              `min-h` because without it every switch between a one-line and a
              two-line blurb would shift the Play button under the cursor.
              Deliberately no `animate-fade-in-up`: its fill mode is `both`, so
              content that re-mounts on each selection replays the animation and
              the panel reads as jumpy. */}
          <p className="mt-3 min-h-[2.5rem] px-1 text-xs leading-relaxed text-muted-foreground">
            {selected.blurb}
          </p>

          {error && (
            <ErrorNote
              title="Could not start the game"
              message={error}
              className="mt-4"
            />
          )}

          <Button onClick={play} disabled={busy} className="mt-4 w-full" size="lg">
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                Starting…
              </>
            ) : (
              <>
                Play {selected.name}
                <ArrowRight aria-hidden />
              </>
            )}
          </Button>

          <p className="mt-3 text-center font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            White · Unrated · No clock
          </p>
        </div>

        {/* The board is the point of the app, so the screen shows one. Static —
            it is a preview, not a game — and gone below `lg`, where a phone is
            better served by the roster alone than by a board it cannot use. */}
        <div
          className="animate-fade-in-up hidden [animation-delay:120ms] lg:block"
          aria-hidden
        >
          <ChessBoard
            fen={START_FEN}
            orientation="white"
            interactive={false}
            inCheck={false}
            onMove={() => {}}
            pieceSet={pieceSet}
          />
        </div>
      </div>
    </div>
  );
}
