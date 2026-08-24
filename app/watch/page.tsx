"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Radio, Trophy, Users } from "lucide-react";
import { GameRow } from "@/components/game/game-row";
import { LiveGameCard } from "@/components/game/live-game-card";
import { PageHeader, SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { isGameOver, type GameIndexEntry, type LiveGameEntry } from "@/lib/types";
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

export default function WatchPage() {
  const [live, setLive] = useState<LiveGameEntry[]>([]);
  const [open, setOpen] = useState<GameIndexEntry[]>([]);
  const [recent, setRecent] = useState<GameIndexEntry[]>([]);
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hostedMe = useMemo(() => getStore("hosted").getMyPlayerId(), []);
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  /** Player id → username, for the rows that only carry ids. */
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  /** Local (offline) games use the local identity, not the hosted one. */
  const [localIds, setLocalIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
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
    setLive(remote.live);
    setOpen(remote.open);
    setPlayers(remote.players);
    setLocalIds(new Set(localRecent.map((e) => e.id)));
    setRecent(mergeEntries([...remote.recent, ...localRecent]));
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        await load();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load matches");
        setLoading(false);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Watch"
        title="Watch chess"
        description="Every active match is broadcast here automatically — follow live games, join open ones, or replay a finished game move by move."
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
              description="Every active match appears here automatically — start one and it shows up for everyone."
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
              description="Nobody is waiting for an opponent right now. Create a public game and it will be listed here."
              action={{ href: "/create", label: "Create a game" }}
              className="py-10"
            />
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {open.map((entry) => (
                <GameRow key={entry.id} game={entry} me={hostedMe} names={names} />
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
              description="Every completed game is archived here with a full replay."
              action={{ href: "/create", label: "Play the first one" }}
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
                  names={localIds.has(entry.id) ? undefined : names}
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
