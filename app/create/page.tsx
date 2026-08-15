"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Bot, Check, Gamepad2, Loader2, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getGameBackend } from "@/lib/config";
import { getStore } from "@/lib/store";
import type { AiDifficulty } from "@/lib/types";
import { cn } from "@/lib/utils";

type GameMode = "pvp" | "ai";

function initialMode(): GameMode {
  if (typeof window === "undefined") return "pvp";
  return new URLSearchParams(window.location.search).get("mode") === "ai" ? "ai" : "pvp";
}

export default function CreateGamePage() {
  const router = useRouter();
  const backend = getGameBackend();
  const [mode, setMode] = useState<GameMode>(initialMode);
  const [difficulty, setDifficulty] = useState<AiDifficulty>("casual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const game =
        mode === "ai"
          ? await getStore("local").createAiGame(difficulty)
          : await getStore().createGame();
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the game");
      setBusy(false);
    }
  }, [router, mode, difficulty]);

  const backendBlurb =
    backend === "genlayer"
      ? "A fresh ChainMate contract is deployed and you play White. Share the game link to invite Black."
      : backend === "hosted"
        ? "A game is created instantly in the shared store. Share the link — your opponent joins as Black from any device."
        : "A local game is created instantly and you play White. Open the share link in another tab of this same browser to play Black.";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-14 sm:px-6 lg:py-20">
      <div className="animate-fade-in-up w-full text-center">
        <Badge variant="secondary" className="mb-4">
          <ShieldCheck className="mr-1 h-3 w-3 text-emerald-400" aria-hidden />
          {backend === "genlayer"
            ? "GenLayer network"
            : backend === "hosted"
              ? "Online mode"
              : "Local mode"}
        </Badge>
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Start a game
        </h1>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">{backendBlurb}</p>
      </div>

      <Card className="mt-8 w-full max-w-md animate-fade-in-up [animation-delay:100ms]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gamepad2 className="h-5 w-5 text-primary" aria-hidden />
            New chess match
          </CardTitle>
          <CardDescription>
            Play a friend, or challenge the on-device AI.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode picker */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode("pvp")}
              aria-pressed={mode === "pvp"}
              className={cn(
                "relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
                mode === "pvp"
                  ? "border-primary/60 bg-primary/10 shadow-[0_0_20px_-8px] shadow-primary/40"
                  : "border-border/70 bg-secondary/30 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg",
              )}
            >
              {mode === "pvp" && (
                <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" aria-hidden />
                </span>
              )}
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <Users className="h-4 w-4 text-primary" aria-hidden />
                2 players
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                You play White, a friend plays Black.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode("ai")}
              aria-pressed={mode === "ai"}
              className={cn(
                "relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
                mode === "ai"
                  ? "border-primary/60 bg-primary/10 shadow-[0_0_20px_-8px] shadow-primary/40"
                  : "border-border/70 bg-secondary/30 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg",
              )}
            >
              {mode === "ai" && (
                <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" aria-hidden />
                </span>
              )}
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <Bot className="h-4 w-4 text-primary" aria-hidden />
                Play vs AI
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                Single player, instant match, no setup.
              </span>
            </button>
          </div>

          {mode === "pvp" ? (
            <div className="rounded-lg border border-border/70 bg-secondary/30 p-4 text-sm text-foreground/85">
              <p className="font-medium">You will play:</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-zinc-100 text-base text-zinc-900">
                  ♔
                </span>
                <span className="font-semibold">White</span>
                <span className="ml-auto text-xs text-muted-foreground">moves first</span>
              </div>
              {backend === "local" && (
                <p className="mt-3 text-xs leading-snug text-muted-foreground">
                  Local games live in this browser only — cross-device play is
                  available in the default online mode.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 bg-secondary/30 p-4 text-sm text-foreground/85">
              <p className="font-medium">You play White against the AI (Black).</p>
              <div className="mt-3 space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Difficulty
                </p>
                <div
                  className="grid grid-cols-2 gap-1 rounded-lg border border-border/70 bg-secondary/40 p-1"
                  role="radiogroup"
                  aria-label="AI difficulty"
                >
                  {(
                    [
                      { id: "casual", label: "Casual" },
                      { id: "competitive", label: "Competitive" },
                    ] as const
                  ).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      role="radio"
                      aria-checked={difficulty === d.id}
                      onClick={() => setDifficulty(d.id)}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                        difficulty === d.id
                          ? "bg-card text-foreground shadow-sm ring-1 ring-primary/40"
                          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs leading-snug text-muted-foreground">
                  Casual thinks 2 moves ahead, competitive 3 — both run entirely
                  in your browser.
                </p>
              </div>
            </div>
          )}

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
                {mode === "ai" ? <Bot aria-hidden /> : <Gamepad2 aria-hidden />}
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
