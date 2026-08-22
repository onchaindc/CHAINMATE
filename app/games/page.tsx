"use client";

import { useEffect, useMemo, useState } from "react";
import { Gamepad2 } from "lucide-react";
import { RequireProfile } from "@/components/auth/require-profile";
import { GameRow } from "@/components/game/game-row";
import { GuestBanner } from "@/components/auth/guest-banner";
import { PageHeader, SectionLabel } from "@/components/ui/page-header";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { mergeGamesById, cn } from "@/lib/utils";
import type { GameState } from "@/lib/types";

export default function GamesPage() {
  return (
    <RequireProfile>
      <GamesContent />
    </RequireProfile>
  );
}

function GamesContent() {
  const identity = useIdentity();
  const [games, setGames] = useState<GameState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Map<string, number>>(new Map());
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});

  // Usernames from the server for everyone in this list (real identities).
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  const activeGames =
    games?.filter((g) => g.status === "waiting" || g.status === "active") ?? null;
  const completedGames = games?.filter((g) => !(g.status === "waiting" || g.status === "active")) ?? null;

  useEffect(() => {
    // Wait for the real identity, like the profile page does — fetching on the
    // empty interim id returns an empty record, and the effect would not re-run
    // if the id resolved before this component mounted.
    if (identity.status === "loading" || !identity.playerId) return;
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [remote, localGames, profile] = await Promise.all([
          hosted.listMine(),
          Promise.resolve(local.listMyGames()),
          // Pass the resolved id: the deltas below are keyed to
          // identity.playerId, so reading history for a different id would
          // silently pair one player's games with another's rating changes.
          hosted.myProfile(identity.playerId),
        ]);
        if (cancelled) return;
        setGames(mergeGamesById([...remote.games, ...localGames]));
        setPlayers(remote.players);
        setDeltas(
          new Map([
            // Deltas stamped on the games themselves are durable; the stats
            // history is per-instance, so it can be missing entries.
            ...remote.games.flatMap((g) => {
              const change = g.ratings?.[identity.playerId]?.change;
              return change === undefined
                ? []
                : ([[g.id, change]] as [string, number][]);
            }),
            ...profile.stats.ratingHistory.map(
              (h) => [h.gameId, h.change] as [string, number],
            ),
          ]),
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load games");
        setGames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.playerId, identity.status]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Your record"
        title="Games"
        description={`Every match played by ${
          identity.isGuest ? "this device" : "your account"
        }, from the online store and local mode.`}
      />

      {identity.isGuest && (
        <div className="mt-6 animate-fade-in-up [animation-delay:60ms]">
          <GuestBanner />
        </div>
      )}

      {/* Active session: games the player joined but hasn't finished or resigned */}
      {activeGames !== null && activeGames.length > 0 && (
        <div className="mt-8 animate-fade-in-up [animation-delay:80ms]">
          <SectionLabel live aside="Finish or resign a game to end your session.">
            Active session
          </SectionLabel>
          <div className="mt-3 overflow-hidden rounded-lg border border-primary/25 bg-card/50">
            <div className="divide-y divide-border/50 px-2 py-2">
              {activeGames.map((game) => (
                <GameRow
                  key={game.id}
                  game={game}
                  me={game.backend === "local" ? localMe : identity.playerId}
                  delta={game.backend === "local" ? null : deltas.get(game.id)}
                  names={game.backend === "local" ? undefined : names}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {activeGames !== null && activeGames.length > 0 && (
        <SectionLabel className="mt-8 animate-fade-in-up [animation-delay:80ms]">
          Completed
        </SectionLabel>
      )}

      <div
        className={cn(
          "animate-fade-in-up overflow-hidden rounded-lg border border-border/70 bg-card/50 [animation-delay:80ms]",
          activeGames !== null && activeGames.length > 0 && "mt-3",
        )}
      >
        {error && <ErrorNote message={error} className="rounded-none border-0 border-b" />}

        {games === null ? (
          <LoadingRows />
        ) : games.length === 0 ? (
          <EmptyState
            icon={Gamepad2}
            title="No games yet"
            description="Play your first match — create a game or challenge the computer."
            action={{ href: "/create", label: "Create a game" }}
          />
        ) : (completedGames ?? []).length === 0 ? (
          <EmptyState
            title="No completed games yet"
            description="Your finished matches will appear here."
            className="py-12"
          />
        ) : (
          <div className="divide-y divide-border/50 px-2 py-2">
            {(completedGames ?? []).map((game) => (
              <GameRow
                key={game.id}
                game={game}
                me={game.backend === "local" ? localMe : identity.playerId}
                delta={game.backend === "local" ? null : deltas.get(game.id)}
                names={game.backend === "local" ? undefined : names}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
