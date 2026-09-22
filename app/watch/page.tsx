"use client";

import { useMemo } from "react";
import { Radio, Trophy, Users } from "lucide-react";
import { GameRow } from "@/components/game/game-row";
import { LiveGameCard } from "@/components/game/live-game-card";
import { PageHeader, SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useCachedRead } from "@/lib/read-cache";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { isGameOver, isPlayedGame, type GameIndexEntry, type LiveGameEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Watch — the live broadcast feed.
 *
 * Every game that enters LIVE state is registered automatically by the server
 * store (lib/server/hosted.ts) and removed the moment it ends, so this page is
 * always showing real, current matches. It polls the real feed every few
 * seconds; there is no manual "publish" step and no fabricated data.
 */
const POLL_MS = 5000;

/** Everything the watch page renders, as ONE cached payload. */
interface WatchData {
  live: LiveGameEntry[];
  open: GameIndexEntry[];
  recent: GameIndexEntry[];
  players: Record<string, PlayerInfo>;
  localIds: Set<string>;
}

const EMPTY_LOCAL_IDS = new Set<string>();

async function loadWatch(): Promise<WatchData> {
  const hosted = getStore("hosted") as HostedGameStore;
  const local = getStore("local") as LocalGameStore;
  const [remote, localGames] = await Promise.all([
    hosted.listWatch(),
    Promise.resolve(local.listMyGames()),
  ]);
  const localRecent = localGames
    .filter((g) => isGameOver(g.status))
    .map<GameIndexEntry>((g) => ({
      id: g.id,
      updatedAt: g.updatedAt ?? 0,
      createdAt: g.createdAt ?? 0,
      creator: g.creator,
      opponent: g.opponent,
      status: g.status,
      winner: g.winner,
      timeControl: g.timeControl,
      visibility: g.visibility,
      endedAt: g.endedAt,
    }));
  return {
    live: remote.live,
    open: remote.open,
    players: remote.players,
    localIds: new Set(localRecent.map((e) => e.id)),
    recent: mergeEntries([...remote.recent, ...localRecent]).filter(isPlayedGame),
  };
}

export default function WatchPage() {
  // Cached read: the live feed renders from the session cache the moment you
  // navigate here (the 5s poll keeps it live exactly as before), so revisits
  // never blank into a skeleton.
  const { data, error } = useCachedRead<WatchData>("watch:feed", loadWatch, {
    pollMs: POLL_MS,
  });
  const live = data?.live ?? [];
  const open = data?.open ?? [];
  const recent = data?.recent ?? [];
  const players = data?.players ?? {};
  const localIds = data?.localIds ?? EMPTY_LOCAL_IDS;
  const loading = data === null;
  const hostedMe = useMemo(() => getStore("hosted").getMyPlayerId(), []);
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  return (
    <div className="shell px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Live"
        title="Watch"
        description="Live games, open challenges, and finished games to replay."
      />

      {error && <ErrorNote message={error} className="mt-6" />}

      {/* Live now — real active games from the live registry.
          The fade is gated on `!loading` throughout this page: `fade-in-up` has
          fill mode `both` and runs once at mount, so at t=0 it animated the
          loading skeletons and had already finished — leaving the real rows to
          appear with no transition at all. */}
      <section className={cn("mt-8", !loading && "animate-fade-in-up")}>
        <SectionLabel
          live={!loading && live.length > 0}
          aside={!loading && live.length > 0 ? `${live.length} active` : undefined}
        >
          {/* The pulsing dot is the liveness cue when there is something live,
              so the radio icon only earns its place when there isn't. */}
          {(loading || live.length === 0) && (
            <Radio className="h-3.5 w-3.5" aria-hidden />
          )}
          Live now
        </SectionLabel>
        <Panel className="mt-3">
          {loading ? (
            <LoadingRows rows={2} rowClassName="h-16" />
          ) : live.length === 0 ? (
            <EmptyState
              icon={Radio}
              title="No live games right now"
              description="Start a game and it appears here."
              action={{ href: "/create", label: "Start a game" }}
              className="py-10"
            />
          ) : (
            <div className="divide-y divide-border/50">
              {live.map((entry) => (
                <LiveGameCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </Panel>
      </section>

      {/* Open games — public matches waiting for an opponent */}
      <section className={cn("mt-8", !loading && "animate-fade-in-up [animation-delay:60ms]")}>
        <SectionLabel>
          <Users className="h-3.5 w-3.5" aria-hidden />
          Open games
        </SectionLabel>
        <Panel className="mt-3">
          {loading ? (
            <LoadingRows rows={1} />
          ) : open.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No open games"
              description="Nobody is waiting for an opponent."
              action={{ href: "/create", label: "Create a game" }}
              className="py-10"
            />
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {open.map((entry) => (
                <GameRow key={entry.id} game={entry} me={hostedMe} players={players} />
              ))}
            </div>
          )}
        </Panel>
      </section>

      {/* Recent completed matches */}
      <section className={cn("mt-8", !loading && "animate-fade-in-up [animation-delay:120ms]")}>
        <SectionLabel>
          <Trophy className="h-3.5 w-3.5" aria-hidden />
          Recent matches
        </SectionLabel>
        <Panel className="mt-3">
          {loading ? (
            <LoadingRows rows={2} />
          ) : recent.length === 0 ? (
            <EmptyState
              icon={Trophy}
              title="No finished matches yet"
              description="Replays appear here."
              action={{ href: "/create", label: "Create a game" }}
              className="py-10"
            />
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {recent.map((entry) => (
                <GameRow
                  key={entry.id}
                  game={entry}
                  /* Offline games were played under the local identity, so
                     "You" only lines up when matched against that one. */
                  me={localIds.has(entry.id) ? localMe : hostedMe}
                  players={localIds.has(entry.id) ? undefined : players}
                />
              ))}
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}

function mergeEntries(entries: GameIndexEntry[]): GameIndexEntry[] {
  const map = new Map<string, GameIndexEntry>();
  for (const e of entries) map.set(e.id, e);
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
