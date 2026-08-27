"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorNote } from "@/components/ui/states";
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
      <PageHeader
        align="center"
        eyebrow="Invite"
        title="Join a game"
        description="Paste an invite link or game id. You play Black."
        className="w-full"
      />

      <Card className="mt-8 animate-fade-in-up [animation-delay:80ms]">
        <CardContent className="p-5">
          <form onSubmit={join} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="game-id" className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
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

            {error && <ErrorNote title="Could not join" message={error} />}

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
