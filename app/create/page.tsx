"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Gamepad2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getGameBackend } from "@/lib/config";
import { getStore } from "@/lib/store";

export default function CreateGamePage() {
  const router = useRouter();
  const backend = getGameBackend();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const store = getStore();
      const game = await store.createGame();
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the game");
      setBusy(false);
    }
  }, [router]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-14 sm:px-6 lg:py-20">
      <div className="animate-fade-in-up w-full text-center">
        <Badge variant="secondary" className="mb-4">
          <ShieldCheck className="mr-1 h-3 w-3 text-emerald-400" aria-hidden />
          {backend === "genlayer" ? "GenLayer network" : "Local mode"}
        </Badge>
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Create a game
        </h1>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">
          {backend === "genlayer"
            ? "A fresh ChainMate contract is deployed and you play White. Share the game link to invite Black."
            : "A local game is created instantly and you play White. Open the share link in another tab or browser to play Black."}
        </p>
      </div>

      <Card className="mt-8 w-full max-w-md animate-fade-in-up [animation-delay:100ms]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gamepad2 className="h-5 w-5 text-primary" aria-hidden />
            New chess match
          </CardTitle>
          <CardDescription>
            One smart contract, two players, full AI analysis.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-4 text-sm text-foreground/85">
            <p className="font-medium">You will play:</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-zinc-100 text-base text-zinc-900">
                ♔
              </span>
              <span className="font-semibold">White</span>
              <span className="ml-auto text-xs text-muted-foreground">
                moves first
              </span>
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button onClick={create} disabled={busy} className="w-full" size="lg">
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                {backend === "genlayer" ? "Deploying contract…" : "Creating game…"}
              </>
            ) : (
              <>
                <Gamepad2 aria-hidden />
                Create game
              </>
            )}
          </Button>

          {backend === "genlayer" && (
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
