"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ArrowRight, Bot, Crown, Loader2, Search, ShieldCheck, Swords, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getGameBackend } from "@/lib/config";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { AI_LEVELS, type AiDifficulty } from "@/lib/types";
import { cn } from "@/lib/utils";

type GameMode = "pvp" | "ai";

function initialMode(): GameMode {
  if (typeof window === "undefined") return "pvp";
  return new URLSearchParams(window.location.search).get("mode") === "ai" ? "ai" : "pvp";
}

const MODES: { id: GameMode; label: string; icon: typeof Users }[] = [
  { id: "pvp", label: "2 players", icon: Users },
  { id: "ai", label: "Play vs AI", icon: Bot },
];

const TIME_CONTROLS = ["5 + 0", "10 + 0", "15 + 10"] as const;

export default function CreateGamePage() {
  const router = useRouter();
  const backend = getGameBackend();
  const [mode, setMode] = useState<GameMode>(initialMode);
  const [difficulty, setDifficulty] = useState<AiDifficulty>("casual");
  const [timeControl, setTimeControl] = useState<string>("10 + 0");
  // Live games are broadcast to Watch automatically — "public" is the
  // default so matches are discoverable with zero setup. "Private" is an
  // explicit opt-out for invite-only games.
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True while matchmaking: registered in the seek pool, polling for a pair. */
  const [seeking, setSeeking] = useState(false);
  const mountedRef = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      // Leaving the page cancels a pending search so the pool never rots.
      if (seeking) void (getStore("hosted") as HostedGameStore).cancelSeek().catch(() => {});
    };
  }, [seeking]);

  /** Register in the seek pool, then poll for a compatible partner. */
  const findOpponent = useCallback(async () => {
    setError(null);
    setBusy(true);
    attemptsRef.current = 0;
    try {
      const store = getStore("hosted") as HostedGameStore;
      const first = await store.seekMatch(timeControl);
      if (!mountedRef.current) return;
      if (first.status === "matched") {
        router.push(`/game/${first.game.id}`);
        return;
      }
      setBusy(false);
      setSeeking(true);
      const poll = () => {
        pollTimer.current = setTimeout(async () => {
          if (!mountedRef.current) return;
          attemptsRef.current += 1;
          // Give it ~15s, then fall back to the normal options.
          if (attemptsRef.current >= 6) {
            setSeeking(false);
            void (getStore("hosted") as HostedGameStore).cancelSeek().catch(() => {});
            return;
          }
          try {
            const result = await (getStore("hosted") as HostedGameStore).pollSeek(timeControl);
            if (result.status === "matched") {
              setSeeking(false);
              router.push(`/game/${result.game.id}`);
              return;
            }
          } catch {
            // transient — keep polling
          }
          poll();
        }, 2500);
      };
      poll();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Failed to find an opponent");
    }
  }, [router, timeControl]);

  const cancelSearch = useCallback(() => {
    setSeeking(false);
    setBusy(false);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    void (getStore("hosted") as HostedGameStore).cancelSeek().catch(() => {});
  }, []);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const game =
        mode === "ai"
          ? await getStore("local").createAiGame(difficulty)
          : await getStore().createGame({ timeControl, visibility });
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the game");
      setBusy(false);
    }
  }, [router, mode, difficulty, timeControl, visibility]);

  const selected = MODES.find((m) => m.id === mode)!;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-14 sm:px-6 lg:py-20">
      <div className="animate-fade-in-up w-full text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          New match
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">
          Create a game
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {backend === "genlayer"
            ? "A fresh ChainMate contract is deployed and you play White. Share the game link to invite Black."
            : "You play White. Share the link — your opponent joins as Black from any device."}
        </p>
      </div>

      <Card className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <CardContent className="space-y-5 p-5">
          {/* Play online — live matchmaking with real players */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => void findOpponent()}
              disabled={busy || seeking}
              className="w-full"
              size="lg"
            >
              {busy && !seeking ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Swords aria-hidden />
              )}
              {seeking
                ? "Searching…"
                : busy
                  ? "Finding opponent…"
                  : "Play online — find a match"}
            </Button>
            <p className="text-center text-[11px] leading-snug text-muted-foreground">
              Pairs you with a live player of similar rating in the same time
              control ({timeControl}). If no one is searching right now, you&rsquo;ll
              see the options below instead.
            </p>
          </div>

          {seeking && (
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
              <Button variant="outline" size="sm" onClick={cancelSearch}>
                Cancel search
              </Button>
            </div>
          )}

          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-border/70" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              or set up a game
            </span>
            <span className="h-px flex-1 bg-border/70" />
          </div>

          {/* Mode — segmented control */}
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Game type
            </p>
            <div
              className="grid grid-cols-2 gap-1 rounded-lg border border-border/70 bg-secondary/50 p-1"
              role="radiogroup"
              aria-label="Game type"
            >
              {MODES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={mode === id}
                  onClick={() => setMode(id)}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
                    mode === id
                      ? "bg-card text-foreground shadow-sm ring-1 ring-primary/30"
                      : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                  )}
                >
                  <Icon className={cn("h-4 w-4", mode === id && "text-primary")} aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Time control — segmented control (PvP) */}
          {mode === "pvp" && (
            <div className="animate-fade-in-up">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                    onClick={() => setTimeControl(tc)}
                    className={cn(
                      "rounded-md px-2 py-2 font-mono text-sm tabular-nums transition-all",
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
          )}

          {/* Visibility — segmented control (PvP) */}
          {mode === "pvp" && (
            <div className="animate-fade-in-up">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Game type
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
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                      {v.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AI difficulty — pick a named opponent, chess.com-style */}
          {mode === "ai" && (
            <div className="animate-fade-in-up">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Opponent
              </p>
              <div
                className="space-y-1.5"
                role="radiogroup"
                aria-label="AI difficulty"
              >
                {AI_LEVELS.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    role="radio"
                    aria-checked={difficulty === level.id}
                    onClick={() => setDifficulty(level.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-all",
                      difficulty === level.id
                        ? "border-primary/40 bg-primary/[0.06] ring-1 ring-primary/25"
                        : "border-border/70 bg-secondary/30 hover:bg-card/60",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="truncate">{level.name}</span>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-primary">
                          {level.rating}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {level.blurb}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 rounded-full border",
                        difficulty === level.id
                          ? "border-primary bg-primary"
                          : "border-border bg-transparent",
                      )}
                    />
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Pick an opponent. The computer plays Black — instant, no setup.
              </p>
            </div>
          )}

          {/* Side info */}
          <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-400 bg-zinc-100 text-zinc-900">
              {/* Lucide crown, not ♔ — Windows has no font for the Unicode
                  chess glyphs, so this disc showed an empty box. */}
              <Crown className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                You play <span className="text-foreground">White</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {mode === "ai"
                  ? "Casual match — games against the computer never change your rating."
                  : "White moves first. Games are rated and broadcast live on Watch by default."}
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

          {error && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-destructive">
                  Could not create the game
                </p>
                <p className="mt-0.5 text-xs leading-snug text-destructive/90">{error}</p>
              </div>
            </div>
          )}

          <Button onClick={create} disabled={busy} className="w-full" size="lg">
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                {backend === "genlayer" && mode === "pvp" ? "Deploying contract…" : "Creating game…"}
              </>
            ) : (
              <>
                {selected.icon === Bot ? <Bot aria-hidden /> : <Users aria-hidden />}
                {mode === "ai" ? "Play vs AI" : "Create game"}
              </>
            )}
          </Button>

          {backend === "genlayer" && mode === "pvp" && (
            <p className="text-center text-[11px] leading-snug text-muted-foreground/70">
              Deployment is signed with the server-side GENLAYER_PRIVATE_KEY and
              can take a few seconds on testnet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
