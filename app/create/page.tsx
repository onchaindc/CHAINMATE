"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Crown, Loader2, Search, ShieldCheck, Swords, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorNote } from "@/components/ui/states";
import { getGameBackend } from "@/lib/config";
import { getStore } from "@/lib/store";
import { useMatchmaking } from "@/lib/use-matchmaking";
import { cn } from "@/lib/utils";

/**
 * Create a game — two players.
 *
 * This page served single-player too, behind `?mode=ai`, and paid for it
 * throughout: a mode toggle, an opponent roster, and four copy branches for a
 * decision most visitors never made. Solo is `/solo` now, so every block here
 * states the two-player case as a fact instead of a branch.
 */

const TIME_CONTROLS = ["5 + 0", "10 + 0", "15 + 10"] as const;

export default function CreateGamePage() {
  const router = useRouter();
  const backend = getGameBackend();
  const match = useMatchmaking();
  const [timeControl, setTimeControl] = useState<string>("10 + 0");
  // Live games are broadcast to Watch automatically — "public" is the
  // default so matches are discoverable with zero setup. "Private" is an
  // explicit opt-out for invite-only games.
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * `?mode=ai` used to flip this page into single-player. Solo has its own
   * screen now, so old bookmarks, shared links and anything still pointing here
   * get forwarded rather than landing on a two-player form.
   *
   * Read off `window.location.search` rather than through `useSearchParams()`,
   * which would oblige this page to sit inside a Suspense boundary to stay
   * prerenderable — it is one of the statically generated set. The mode state
   * this replaces read the query the same way, for the same reason.
   */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "ai") {
      router.replace("/solo");
    }
  }, [router]);

  /** Nothing else should start while a search or a creation is in flight. */
  const locked = busy || match.starting || match.seeking;

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const game = await getStore().createGame({ timeControl, visibility });
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the game");
      setBusy(false);
    }
  }, [router, timeControl, visibility]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-14 sm:px-6 lg:py-20">
      <PageHeader
        align="center"
        eyebrow="New match"
        title="Create a game"
        description={
          backend === "genlayer"
            ? "A fresh ChainMate contract is deployed and you play White. Share the game link to invite Black."
            : "You play White. Share the link — your opponent joins as Black from any device."
        }
        className="w-full"
      />

      <Card className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <CardContent className="space-y-5 p-5">
          {/* Play online — live matchmaking with real players */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => void match.start(timeControl)}
              disabled={locked}
              className="w-full"
              size="lg"
            >
              {match.starting ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Swords aria-hidden />
              )}
              {match.seeking
                ? "Searching…"
                : match.starting
                  ? "Finding opponent…"
                  : "Play online — find a match"}
            </Button>
            <p className="text-center text-2xs leading-snug text-muted-foreground">
              Pairs you with a live player of similar rating in the same time
              control ({timeControl}). If no one is searching right now, you&rsquo;ll
              see the options below instead.
            </p>
          </div>

          {match.error && <ErrorNote message={match.error} />}

          {match.seeking && (
            <div className="animate-fade-in-up flex flex-col items-center gap-3 rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-5 text-center">
              <Search className="h-5 w-5 animate-pulse-soft text-primary" aria-hidden />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Searching for an opponent…
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  You&rsquo;re in the pool. The moment another player starts
                  searching at a compatible rating, a rated match begins and
                  this page takes you straight to it.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={match.cancel}>
                Cancel search
              </Button>
            </div>
          )}

          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-border/70" />
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              or set up a game
            </span>
            <span className="h-px flex-1 bg-border/70" />
          </div>

          {/* Time control — segmented control */}
          <div>
            <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Time control
            </p>
            <div
              className="grid grid-cols-3 gap-1 rounded-lg border border-border/70 bg-secondary/50 p-1"
              role="radiogroup"
              aria-label="Time control"
            >
              {TIME_CONTROLS.map((tc) => (
                <button
                  key={tc}
                  type="button"
                  role="radio"
                  aria-checked={timeControl === tc}
                  /* Changing this mid-search would leave the pool
                     registration on the old control while the label above
                     claimed the new one. */
                  disabled={locked}
                  onClick={() => setTimeControl(tc)}
                  className={cn(
                    "rounded-md px-2 py-2 font-mono text-sm tabular-nums transition-all disabled:opacity-60",
                    timeControl === tc
                      ? "bg-card text-foreground shadow-sm ring-1 ring-primary/30"
                      : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                  )}
                >
                  {tc}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Minutes per side + increment per move. Real clocks with
              automatic flag-fall — if your time runs out, you lose on time.
            </p>
          </div>

          {/* Visibility — segmented control */}
          <div>
            <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Visibility
            </p>
            <div
              className="grid grid-cols-2 gap-1 rounded-lg border border-border/70 bg-secondary/50 p-1"
              role="radiogroup"
              aria-label="Game visibility"
            >
              {(
                [
                  { id: "public", label: "Public", hint: "live on Watch" },
                  { id: "private", label: "Private", hint: "invite only" },
                ] as const
              ).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={visibility === v.id}
                  onClick={() => setVisibility(v.id)}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium transition-all",
                    visibility === v.id
                      ? "bg-card text-foreground shadow-sm ring-1 ring-primary/30"
                      : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                  )}
                >
                  {v.label}
                  <span className="ml-1.5 font-mono text-2xs text-muted-foreground">
                    {v.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Side info */}
          <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2.5">
            {/* The piece tokens, not zinc: this disc stands in for the white
                pieces, and a chess piece is the same colour in either UI theme
                — which is what `--piece-*` is defined for. Fixed zinc read as
                light-on-light in the light theme. */}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-piece-outline/25 bg-piece-light text-piece-dark">
              {/* Lucide crown, not ♔ — Windows has no font for the Unicode
                  chess glyphs, so this disc showed an empty box. */}
              <Crown className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                You play <span className="text-foreground">White</span>
              </p>
              <p className="text-xs text-muted-foreground">
                White moves first. Games are rated and broadcast live on Watch by default.
              </p>
            </div>
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary/70" aria-hidden />
          </div>

          {/* Direct challenge — find a player and invite them */}
          <Link
            href="/profile"
            className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Challenge a specific player <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>

          {error && <ErrorNote title="Could not create the game" message={error} />}

          <Button onClick={create} disabled={locked} className="w-full" size="lg">
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                {backend === "genlayer" ? "Deploying contract…" : "Creating game…"}
              </>
            ) : (
              <>
                <Users aria-hidden />
                Create game
              </>
            )}
          </Button>

          {backend === "genlayer" && (
            <p className="text-center text-2xs leading-snug text-muted-foreground/70">
              Deployment is signed with the server-side GENLAYER_PRIVATE_KEY and
              can take a few seconds on testnet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
