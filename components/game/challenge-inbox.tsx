"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, Swords, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/ui/country-flag";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { shortId, type GameState } from "@/lib/types";

/** How often to check for a challenge. Fast enough to feel live. */
const POLL_MS = 5000;

/**
 * The incoming-challenge notification, mounted app-wide.
 *
 * A challenge is a live invitation — the other player is sitting there waiting
 * for an answer — so it has to find you wherever you are in the app, the way it
 * does on chess.com. Leaving it to be discovered in a list of past games means
 * nobody ever sees it in time.
 *
 * Everything shown is real: the challenger's name, rating and country come from
 * their profile, and Accept starts the actual game the challenge created.
 */
export function ChallengeInbox() {
  const identity = useIdentity();
  const router = useRouter();
  const pathname = usePathname();
  const [challenges, setChallenges] = useState<GameState[]>([]);
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Answered or hidden by hand — never show these again this session. */
  const dismissed = useRef<Set<string>>(new Set());

  const ready = identity.status !== "loading" && identity.playerId !== "";

  const refresh = useCallback(async () => {
    try {
      const store = getStore("hosted") as HostedGameStore;
      const data = await store.listChallenges();
      setChallenges(data.challenges.filter((g) => !dismissed.current.has(g.id)));
      setPlayers(data.players);
    } catch {
      // Offline, or challenges aren't configured on this deployment — staying
      // silent is right: this is a notification, not a page the user opened.
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  const forget = (id: string) => {
    dismissed.current.add(id);
    setChallenges((list) => list.filter((c) => c.id !== id));
  };

  const accept = async (game: GameState) => {
    setBusyId(game.id);
    setError(null);
    try {
      const store = getStore("hosted") as HostedGameStore;
      const started = await store.acceptChallenge(game.id);
      forget(game.id);
      router.push(`/game/${started.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept that challenge.");
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (game: GameState) => {
    setBusyId(game.id);
    setError(null);
    try {
      const store = getStore("hosted") as HostedGameStore;
      await store.declineChallenge(game.id);
      forget(game.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't decline that challenge.");
    } finally {
      setBusyId(null);
    }
  };

  // Don't shout about a game the player is already looking at.
  const visible = challenges.filter((g) => pathname !== `/game/${g.id}`).slice(0, 2);
  if (visible.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 sm:w-80"
      role="region"
      aria-label="Incoming challenges"
    >
      {visible.map((game) => {
        const from = players[game.creator];
        const name = from?.name ?? shortId(game.creator);
        const busy = busyId === game.id;
        return (
          <div
            key={game.id}
            className="animate-fade-in-up rounded-lg border border-primary/30 bg-card/95 p-3.5 shadow-elevation-3 backdrop-blur"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.18em] text-primary">
                <span
                  className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary"
                  aria-hidden
                />
                Challenge
              </p>
              <button
                type="button"
                onClick={() => forget(game.id)}
                aria-label="Hide this challenge"
                className="-mr-1 -mt-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-medium text-foreground">{name}</span>
              {from?.country && <CountryFlag code={from.country} className="h-3 w-[18px]" />}
              {from?.rating !== undefined && (
                <span className="font-mono text-xs tabular-nums text-primary">
                  {from.rating}
                </span>
              )}
              <span className="text-muted-foreground">challenged you</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Rated game{game.timeControl ? ` · ${game.timeControl}` : ""} — they&rsquo;re
              waiting for your answer.
            </p>

            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                disabled={busy}
                onClick={() => void accept(game)}
              >
                {busy ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Swords className="h-3.5 w-3.5" aria-hidden />
                )}
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void decline(game)}
              >
                Decline
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
