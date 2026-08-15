"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getGameBackend } from "@/lib/config";
import { getStoreForId } from "@/lib/store";
import { cn } from "@/lib/utils";

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
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-14 sm:px-6 lg:py-20">
      <div className="animate-fade-in-up w-full text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Invite
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold tracking-tight">Join a game</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Enter the game id or paste the invite link your opponent shared.
          You&rsquo;ll play Black.
        </p>
      </div>

      <Card className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <CardContent className="p-5">
          <form onSubmit={join} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="game-id" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Game id or link
              </Label>
              <Input
                id="game-id"
                placeholder={
                  backend === "genlayer"
                    ? "0x1a2b3c… or the full game link"
                    : "hosted_ab12cd or the full game link"
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                className="h-11"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-destructive">Could not join</p>
                  <p className="mt-0.5 text-xs leading-snug text-destructive/90">{error}</p>
                </div>
              </div>
            )}

            <Button type="submit" disabled={busy || !value.trim()} className="w-full" size="lg">
              {busy ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  Joining…
                </>
              ) : (
                "Join game"
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Don&rsquo;t have an invite?{" "}
              <Link
                href="/create"
                className={cn(
                  buttonVariants({ variant: "link", size: "sm" }),
                  "h-auto p-0 text-primary",
                )}
              >
                Create a new game
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
