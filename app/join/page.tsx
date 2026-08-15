"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { getGameBackend } from "@/lib/config";
import { getStoreForId } from "@/lib/store";

function normalizeId(value: string): string {
  const trimmed = value.trim();
  const lastSegment = trimmed.split("/").pop() ?? trimmed;
  return lastSegment.replace(/[?#].*$/, "");
}

export default function JoinGamePage() {
  const router = useRouter();
  const backend = getGameBackend();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const id = normalizeId(value);
      if (!id) {
        setError("Paste the game id or the full game link.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const store = getStoreForId(id);
        const game = await store.joinGame(id);
        router.push(`/game/${game.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not join the game");
        setBusy(false);
      }
    },
    [value, router],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-14 sm:px-6 lg:py-20">
      <div className="animate-fade-in-up w-full text-center">
        <Badge variant="secondary" className="mb-4">
          <Users className="mr-1 h-3 w-3 text-emerald-400" aria-hidden />
          {backend === "genlayer"
            ? "GenLayer network"
            : backend === "hosted"
              ? "Online mode"
              : "Local mode"}
        </Badge>
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Join a game
        </h1>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">
          Enter the game id or paste the invite link your opponent shared.
          You&rsquo;ll play Black.
        </p>
      </div>

      <Card className="mt-8 w-full max-w-md animate-fade-in-up [animation-delay:100ms]">
        <CardHeader>
          <CardTitle>Game invite</CardTitle>
          <CardDescription>One click and you&rsquo;re in the match.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={join} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="game-id">Game id or link</Label>
              <Input
                id="game-id"
                placeholder={
                  backend === "genlayer"
                    ? "0x1a2b3c… or https://…/game/0x1a2b3c"
                    : backend === "hosted"
                      ? "hosted_ab12cd or https://…/game/hosted_ab12cd"
                      : "local_ab12cd or https://…/game/local_ab12cd"
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
              />
            </div>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy || !value.trim()} className="w-full" size="lg">
              {busy ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  Joining…
                </>
              ) : (
                <>
                  <Users aria-hidden />
                  Join game
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
