"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bot,
  ChevronRight,
  Clock,
  Link2,
  Loader2,
  Radio,
  Search,
  Swords,
  Trophy,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CountryFlag } from "@/components/ui/country-flag";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { GameRow } from "@/components/game/game-row";
import { RecentForm } from "@/components/profile/recent-form";
import { SectionLabel } from "@/components/ui/page-header";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { guestDisplayName } from "@/lib/identity";
import { getStore } from "@/lib/store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { useMatchmaking } from "@/lib/use-matchmaking";
import { AI_PLAYER_ID, type GameState, type LiveGameEntry, type PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The signed-in home screen.
 *
 * Guests keep the marketing landing — they still need to be told what this is.
 * A returning player does not: they came to play, and the landing page made
 * them read the pitch again and then hunt for the Play button. This puts the
 * next game one click away and shows the three things that answer "what now?":
 * a game already in progress, who wants to play them, and how they're doing.
 *
 * Every number here is real server data. Nothing on this screen is a
 * placeholder, and no new endpoints were added for it.
 */

const TIME_CONTROLS = ["5 + 0", "10 + 0", "15 + 10"] as const;

/** Live feed and unfinished games move on their own, so this refreshes. */
const POLL_MS = 10_000;

interface LobbyData {
  stats: PlayerStats;
  /** Unfinished games I'm in — waiting for an opponent, or my move to make. */
  mine: GameState[];
  /** Challenges I have sent that nobody has answered yet. */
  sent: GameState[];
  /** Finished games, newest first. */
  recent: GameState[];
  players: Record<string, PlayerInfo>;
  live: LiveGameEntry[];
  friends: PlayerStats[];
}

export function Lobby() {
  const identity = useIdentity();
  const router = useRouter();
  const match = useMatchmaking();
  const [data, setData] = useState<LobbyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timeControl, setTimeControl] = useState<string>("10 + 0");
  const [challenging, setChallenging] = useState<string | null>(null);

  const playerId = identity.playerId;
  const ready = identity.status !== "loading" && Boolean(playerId);

  const load = useCallback(async (me: string) => {
    const store = getStore("hosted") as HostedGameStore;
    /* Four independent reads, all existing endpoints. `friends` is allowed to
       fail on its own — a friends outage should not blank the play button. */
    const [profile, mine, watch, friends] = await Promise.all([
      store.myProfile(me),
      store.listMine(),
      store.listWatch().catch(() => ({ live: [] as LiveGameEntry[] })),
      store.friends().catch(() => ({ friends: [] as PlayerStats[] })),
    ]);
    const unfinished = mine.games.filter(
      (g) =>
        (g.status === "waiting" || g.status === "active") &&
        (g.creator === me || g.opponent === me),
    );
    /* A challenge I sent is also a `waiting` game I created, but it is not
       something I can resume — only the invited player can accept it, and
       telling me to "share the link" would be wrong since holding the link
       does not grant entry. Split those out and report them as pending. */
    const sent = unfinished.filter(
      (g) => Boolean(g.invited) && g.invited !== me && g.creator === me,
    );
    const resumable = unfinished.filter((g) => !sent.includes(g));
    return {
      stats: profile.stats,
      mine: resumable,
      sent,
      recent: profile.games,
      players: { ...mine.players, ...profile.players },
      live: watch.live,
      friends: friends.friends,
    } satisfies LobbyData;
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await load(playerId);
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load your lobby");
        // Keep whatever was already on screen; only the first failure is blank.
        setData((prev) => prev);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ready, playerId, load]);

  /**
   * Player id → username. Folds in friends as well as the games' own player
   * map: a challenge names its target in `invited`, and the games API only
   * resolves names for `creator` and `opponent`, so a sent challenge would
   * otherwise have nobody's name on it.
   */
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of data?.friends ?? []) {
      if (f.username) map[f.playerId] = f.username;
    }
    for (const info of Object.values(data?.players ?? {})) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [data?.players, data?.friends]);

  /** Rating change per game, for the recent list. */
  const deltas = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of data?.stats.ratingHistory ?? []) map.set(h.gameId, h.change);
    for (const g of data?.recent ?? []) {
      const change = g.ratings?.[playerId]?.change;
      if (change !== undefined) map.set(g.id, change);
    }
    return map;
  }, [data?.stats.ratingHistory, data?.recent, playerId]);

  const challengeFriend = async (friendId: string) => {
    setChallenging(friendId);
    setError(null);
    try {
      const store = getStore("hosted") as HostedGameStore;
      const game = await store.challenge(friendId, timeControl);
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the challenge");
      setChallenging(null);
    }
  };

  const stats = data?.stats;
  const resume = data?.mine ?? [];
  const first = resume[0];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:py-14">
      {/* Who you are, and where you stand. */}
      <div className="animate-fade-in-up flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Welcome back
          </p>
          <h1 className="font-display mt-3 truncate text-3xl font-bold tracking-tight">
            {identity.username || "Player"}
          </h1>
        </div>
        <dl className="flex items-center gap-5 sm:gap-7">
          <Stat label="Rating" value={stats ? String(stats.rating) : "—"} accent />
          <Stat
            label="Record"
            value={stats ? `${stats.wins}–${stats.losses}–${stats.draws}` : "—"}
          />
          <Stat
            label="Peak"
            value={stats ? String(stats.peakRating) : "—"}
            className="hidden sm:flex"
          />
        </dl>
      </div>

      {error && <ErrorNote message={error} className="mt-6" />}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_1fr] lg:items-start">
        <div className="min-w-0 space-y-6">
          {/* ---- Play. The reason the page exists. ---- */}
          <section className="animate-fade-in-up overflow-hidden rounded-xl border border-primary/25 bg-card/60">
            {first ? (
              /* An unfinished game outranks starting a new one — leaving it is
                 how a player loses on time without noticing. */
              <div className="p-5">
                <SectionLabel live>Game in progress</SectionLabel>
                <p className="mt-3 text-sm text-muted-foreground">
                  {first.status === "waiting"
                    ? "Waiting for an opponent to join. Share the link, or pick it back up below."
                    : "You have a game on the board. Your clock may still be running."}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Link
                    href={`/game/${first.id}`}
                    className={cn(buttonVariants({ size: "lg" }))}
                  >
                    {first.status === "waiting" ? "Open game" : "Resume game"}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {first.timeControl ?? "Match"}
                    {first.moves.length > 0 && ` · ${first.moves.length} moves`}
                  </span>
                </div>
                {resume.length > 1 && (
                  <div className="mt-4 divide-y divide-border/50 border-t border-border/60 pt-1">
                    {resume.slice(1).map((g) => (
                      <GameRow key={g.id} game={g} me={playerId} names={names} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-5">
                <SectionLabel>Play now</SectionLabel>
                <p className="mt-3 text-sm text-muted-foreground">
                  Pairs you with a live player near your rating. Rated, and it
                  counts towards the leaderboard.
                </p>

                <div
                  className="mt-4 grid grid-cols-3 gap-1 rounded-lg border border-border/70 bg-secondary/50 p-1"
                  role="radiogroup"
                  aria-label="Time control"
                >
                  {TIME_CONTROLS.map((tc) => (
                    <button
                      key={tc}
                      type="button"
                      role="radio"
                      aria-checked={timeControl === tc}
                      disabled={match.seeking || match.starting}
                      onClick={() => setTimeControl(tc)}
                      className={cn(
                        "rounded-md px-3 py-2 font-mono text-xs tabular-nums transition-all disabled:opacity-60",
                        timeControl === tc
                          ? "bg-card font-semibold text-foreground shadow-sm ring-1 ring-primary/30"
                          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                      )}
                    >
                      {tc}
                    </button>
                  ))}
                </div>

                {match.seeking ? (
                  <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-5 text-center">
                    <Search className="h-5 w-5 animate-pulse-soft text-primary" aria-hidden />
                    <div>
                      <p className="text-sm font-medium">Searching for an opponent…</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        You&rsquo;re in the pool at {timeControl}. The moment
                        someone compatible starts searching, the game begins and
                        this page takes you to it.
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={match.cancel}>
                      Cancel search
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="lg"
                    className="mt-4 w-full"
                    disabled={match.starting}
                    onClick={() => void match.start(timeControl)}
                  >
                    {match.starting ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : (
                      <Swords aria-hidden />
                    )}
                    {match.starting ? "Finding opponent…" : "Find a match"}
                  </Button>
                )}

                {match.error && <ErrorNote message={match.error} className="mt-3" />}

                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <LobbyLink href="/create" icon={Clock} label="Set up a game" />
                  <LobbyLink href="/create?mode=ai" icon={Bot} label="Play the computer" />
                  <LobbyLink href="/join" icon={Link2} label="Join by link" />
                </div>
              </div>
            )}
          </section>

          {/* Challenges I sent, still unanswered. Not resumable — the invited
              player is the only one who can start them — so this is a status
              line, not a call to action. */}
          {(data?.sent.length ?? 0) > 0 && (
            <section className="animate-fade-in-up [animation-delay:40ms]">
              <SectionLabel>Waiting on a reply</SectionLabel>
              <ul className="mt-3 divide-y divide-border/50 overflow-hidden rounded-lg border border-border/70 bg-card/50">
                {(data?.sent ?? []).map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        You challenged{" "}
                        <span className="font-medium">
                          {names[g.invited ?? ""] ?? "a player"}
                        </span>
                      </p>
                      <p className="font-mono text-2xs tabular-nums text-muted-foreground">
                        {g.timeControl ?? "Match"}
                      </p>
                    </div>
                    <span className="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground">
                      Pending
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ---- Recent games ---- */}
          <section className="animate-fade-in-up [animation-delay:80ms]">
            <SectionLabel aside={<Link href="/games" className="hover:text-foreground">All games</Link>}>
              Recent games
            </SectionLabel>
            <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
              {data === null ? (
                <LoadingRows rows={3} />
              ) : data.recent.length === 0 ? (
                <EmptyState
                  icon={Trophy}
                  title="No finished games yet"
                  description="Play a rated match and it appears here with the rating change it earned."
                  action={{ href: "/create", label: "Play a rated game" }}
                />
              ) : (
                <div className="divide-y divide-border/50 px-2 py-2">
                  {data.recent.slice(0, 6).map((g) => (
                    <GameRow
                      key={g.id}
                      game={g}
                      me={playerId}
                      delta={deltas.get(g.id) ?? null}
                      names={names}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ---- Sidebar: form, friends, live ---- */}
        <div className="min-w-0 space-y-6">
          {/* Form — the last few results, at a glance. */}
          <RecentForm
            history={stats?.ratingHistory}
            games={data?.recent}
            playerId={playerId}
            streak={stats?.currentStreak}
            loading={data === null}
            className="[animation-delay:60ms]"
          />

          {/* Friends — a known opponent beats a random one. */}
          <section className="animate-fade-in-up [animation-delay:120ms]">
            <SectionLabel
              aside={<Link href="/profile" className="hover:text-foreground">Manage</Link>}
            >
              Friends
            </SectionLabel>
            <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
              {data === null ? (
                <LoadingRows rows={2} />
              ) : data.friends.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <Users className="mx-auto h-6 w-6 text-muted-foreground/50" aria-hidden />
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Add friends from their profile and challenge them straight
                    from here.
                  </p>
                  <Link
                    href="/leaderboard"
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
                  >
                    Browse players
                  </Link>
                </div>
              ) : (
                <ul className="divide-y divide-border/50">
                  {data.friends.slice(0, 5).map((f) => {
                    const name = guestDisplayName(f.username);
                    return (
                      <li key={f.playerId} className="flex items-center gap-2.5 px-3 py-2">
                        <PlayerAvatar name={name} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                            <CountryFlag code={f.country} />
                            <span className="truncate">{name}</span>
                          </p>
                          <p className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {f.rating}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={challenging !== null}
                          onClick={() => void challengeFriend(f.playerId)}
                          aria-label={`Challenge ${name} at ${timeControl}`}
                        >
                          {challenging === f.playerId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Swords className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Challenge
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* Live now — two or three real games in progress. */}
          <section className="animate-fade-in-up [animation-delay:160ms]">
            <SectionLabel
              live={Boolean(data?.live.length)}
              aside={<Link href="/watch" className="hover:text-foreground">Watch all</Link>}
            >
              Live now
            </SectionLabel>
            <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
              {data === null ? (
                <LoadingRows rows={2} />
              ) : data.live.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                  Nobody is playing right now. Start a game and yours is the one
                  being watched.
                </p>
              ) : (
                <ul className="divide-y divide-border/50">
                  {data.live.slice(0, 3).map((entry) => (
                    <li key={entry.id}>
                      <Link
                        href={`/game/${entry.id}`}
                        className="group flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/40"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">
                            {liveName(entry.creator)}{" "}
                            <span className="text-muted-foreground">vs</span>{" "}
                            {liveName(entry.opponent)}
                          </p>
                          <p className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {entry.timeControl ?? "Match"} · {entry.moveCount} ply
                          </p>
                        </div>
                        <Radio
                          className="h-3.5 w-3.5 shrink-0 animate-pulse-soft text-primary"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function liveName(p: { id: string; name?: string; isAi?: boolean }): string {
  if (p.isAi || p.id === AI_PLAYER_ID) return "Computer";
  if (!p.id) return "Waiting…";
  return guestDisplayName(p.name);
}

function Stat({
  label,
  value,
  accent,
  className,
}: {
  label: string;
  value: string;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <dt className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "font-mono text-lg font-semibold tabular-nums",
          accent ? "text-primary" : "text-foreground/90",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function LobbyLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: typeof Bot;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/30 px-3 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight
        className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
        aria-hidden
      />
    </Link>
  );
}
