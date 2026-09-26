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
import { displayNameFor } from "@/lib/identity";
import { useCachedRead } from "@/lib/read-cache";
import { getStore } from "@/lib/store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { LocalGameStore } from "@/lib/store/local-store";
import { useMatchmaking } from "@/lib/use-matchmaking";
import { mergeGamesById } from "@/lib/utils";
import { AI_PLAYER_ID, aiLevelFor, isGameOver, isPlayedGame, type GameState, type LiveGameEntry, type PlayerStats } from "@/lib/types";
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

/** Quick-play pool. Everything here parses everywhere via lib/clocks. */
const TIME_CONTROLS = ["1 + 0", "3 + 2", "5 + 0", "10 + 0"] as const;

/** The pace name each quick-play control plays at — the cadence is the
    choice, the mono numbers are just how it's written. */
const PACE_LABELS: Record<(typeof TIME_CONTROLS)[number], string> = {
  "1 + 0": "Bullet",
  "3 + 2": "Blitz",
  "5 + 0": "Blitz",
  "10 + 0": "Rapid",
};

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
  const [timeControl, setTimeControl] = useState<string>("5 + 0");
  const [challenging, setChallenging] = useState<string | null>(null);

  const playerId = identity.playerId;
  const ready = identity.status !== "loading" && Boolean(playerId);
  /** The device's local player id — solo games are recorded under it, so the
      rows need it to decide Win/Loss for backend="local" games. */
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);

  // Cached read: the lobby's four server reads are keyed per player, so a
  // returning player sees their last-known lobby instantly on navigation and
  // the 10s poll keeps live games/challenges current exactly as before.
  const { data, error, refresh } = useCachedRead<LobbyData>(
    `lobby:${playerId}`,
    () => load(playerId),
    { pollMs: POLL_MS, enabled: ready },
  );

  const load = useCallback(async (me: string) => {
    const store = getStore("hosted") as HostedGameStore;
    /* Five independent reads, all existing sources. `friends` is allowed to
       fail on its own — a friends outage should not blank the play button.
       Local games (solo matches against the Grandmaster) ride along here so
       the recent list is the WHOLE record, not only the rated online one. */
    const [profile, mine, watch, friends, localGames] = await Promise.all([
      store.myProfile(me),
      store.listMine(),
      store.listWatch().catch(() => ({ live: [] as LiveGameEntry[] })),
      store.friends().catch(() => ({ friends: [] as PlayerStats[] })),
      Promise.resolve(
        (getStore("local") as LocalGameStore).listMyGames().filter(isPlayedGame),
      ),
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
      // One merged record: server games first (newest first), local solo
      // games interleaved by recency, deduped by id — FINISHED games only.
      // "Recent games" is a record of results; merging without the terminal
      // filter leaked in-progress solo games as half-empty Live rows, which
      // is what unaligned the section after the local-merge landed.
      recent: mergeGamesById([...profile.games, ...localGames]).filter(
        (g) => isPlayedGame(g) && isGameOver(g.status),
      ),
      players: { ...mine.players, ...profile.players },
      live: watch.live,
      friends: friends.friends,
    } satisfies LobbyData;
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refresh();
  }, [ready, refresh]);

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

  /** Full player info (names + avatars) for the game rows, with friends
      folded in so a fresh friend's row still has a face. */
  const mergedPlayers = useMemo(() => {
    const map: Record<string, PlayerInfo> = { ...(data?.players ?? {}) };
    for (const f of data?.friends ?? []) {
      map[f.playerId] = {
        id: f.playerId,
        name: f.username,
        rating: f.rating,
        country: f.country,
        avatarUrl: f.avatarUrl,
      };
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

  const [challengeError, setChallengeError] = useState<string | null>(null);
  const challengeFriend = async (friendId: string) => {
    setChallenging(friendId);
    setChallengeError(null);
    try {
      const store = getStore("hosted") as HostedGameStore;
      const game = await store.challenge(friendId, timeControl);
      router.push(`/game/${game.id}`);
    } catch (err) {
      setChallengeError(err instanceof Error ? err.message : "Could not send the challenge");
      setChallenging(null);
    }
  };

  const stats = data?.stats;
  const resume = data?.mine ?? [];
  const first = resume[0];

  return (
    /* Wider page container: max-w-5xl left a dead margin on desktops while
       every list inside scrolled or wrapped. max-w-6xl gives the two columns
       room to breathe without ever stretching content on smaller screens. */
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      {/* Who you are, and where you stand. */}
      <div className="animate-fade-in-up flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Welcome back
          </p>
          <h1 className="font-display mt-3 truncate text-3xl font-bold tracking-tight">
            {displayNameFor(identity.playerId, identity.username) || "Player"}
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

      {/* A wider main column: the play box was the reason people visit this
          page, and two narrow columns left it cramped while the sidebar had
          room to spare. */}
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <div className="min-w-0 space-y-6">
          {/* ---- Play. The reason the page exists. ---- */}
          <section className="animate-fade-in-up overflow-hidden rounded-xl border border-primary/25 bg-card/60">
            {first ? (
              /* An unfinished game outranks starting a new one — leaving it is
                 how a player loses on time without noticing. */
              <div className="p-5 sm:p-6">
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
                      <GameRow key={g.id} game={g} me={playerId} players={mergedPlayers} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="p-5 sm:p-6">
                <SectionLabel>Play now</SectionLabel>
                <p className="mt-3 max-w-lg text-sm text-muted-foreground">
                  Pairs you with a live player near your rating. Rated, and it
                  counts towards the leaderboard.
                </p>

                {/* Time control as labelled pace cards instead of bare mono
                    strings — the cadence is the choice a new player actually
                    makes, and "5 + 0" alone reads like a config value. */}
                <div
                  className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
                  role="radiogroup"
                  aria-label="Time control"
                >
                  {TIME_CONTROLS.map((tc) => {
                    const selected = timeControl === tc;
                    return (
                      <button
                        key={tc}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={match.seeking || match.starting}
                        onClick={() => setTimeControl(tc)}
                        className={cn(
                          "group relative flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-all disabled:opacity-60",
                          selected
                            ? "border-primary/50 bg-primary/[0.06] shadow-sm"
                            : "border-border/70 bg-secondary/30 hover:border-border hover:bg-secondary/50",
                        )}
                      >
                        <span
                          className={cn(
                            "font-mono text-sm font-semibold tabular-nums",
                            selected ? "text-primary" : "text-foreground/90",
                          )}
                        >
                          {tc}
                        </span>
                        <span
                          className={cn(
                            "text-2xs uppercase tracking-wider",
                            selected ? "text-foreground/80" : "text-muted-foreground",
                          )}
                        >
                          {PACE_LABELS[tc]}
                        </span>
                        {selected && (
                          <span
                            className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary"
                            aria-hidden
                          />
                        )}
                      </button>
                    );
                  })}
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
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Button
                      size="lg"
                      className="w-full sm:w-auto sm:min-w-64 sm:flex-1 sm:px-8"
                      disabled={match.starting}
                      onClick={() => void match.start(timeControl)}
                    >
                      {match.starting ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Swords aria-hidden />
                      )}
                      {match.starting ? "Finding opponent…" : `Find a match · ${timeControl}`}
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => router.push("/solo")}
                    >
                      <Bot aria-hidden />
                      Play a bot
                    </Button>
                  </div>
                )}

                {challengeError && <ErrorNote message={challengeError} className="mt-3" />}
                {match.error && <ErrorNote message={match.error} className="mt-3" />}

                <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-4 sm:grid-cols-4">
                  <LobbyLink href="/create" icon={Clock} label="Set up a game" />
                  <LobbyLink href="/solo" icon={Bot} label="The Grandmasters" />
                  <LobbyLink href="/join" icon={Link2} label="Join by link" />
                  <LobbyLink href="/tournaments" icon={Trophy} label="Tournaments" />
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
                  description="Your results appear here."
                  action={{ href: "/create", label: "Play a rated game" }}
                />
              ) : (
                <div className="divide-y divide-border/50 px-2 py-2">
                  {data.recent.slice(0, 6).map((g) => (
                    <GameRow
                      key={g.id}
                      game={g}
                      me={g.backend === "local" ? localMe : playerId}
                      meName={g.backend === "local" ? displayNameFor(identity.playerId, identity.username) : undefined}
                      delta={deltas.get(g.id) ?? null}
                      players={mergedPlayers}
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

          {/* Friends — a known opponent beats a random one. The list itself is
              the affordance: every name links to a profile, so a separate
              "Manage" chrome link next to the heading was noise. */}
          <section className="animate-fade-in-up [animation-delay:120ms]">
            <SectionLabel>Friends</SectionLabel>
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
                    const name = displayNameFor(f.playerId, f.username);
                    return (
                      <li key={f.playerId} className="flex items-center gap-2.5 px-3 py-2">
                        {/* The real picture when one exists — the friends list
                            is where faces are expected. */}
                        {!f.isGuest && f.username ? (
                          <Link
                            href={`/players/${encodeURIComponent(f.username)}`}
                            className="shrink-0"
                            aria-label={`${name}'s profile`}
                          >
                            <PlayerAvatar name={name} avatarUrl={f.avatarUrl} size="sm" />
                          </Link>
                        ) : (
                          <PlayerAvatar name={name} avatarUrl={f.avatarUrl} size="sm" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                            <CountryFlag code={f.country} />
                            {!f.isGuest && f.username ? (
                              /* The name IS the profile link — clicking a
                                 friend's name goes to their profile. */
                              <Link
                                href={`/players/${encodeURIComponent(f.username)}`}
                                className="truncate underline-offset-2 hover:underline"
                              >
                                {name}
                              </Link>
                            ) : (
                              <span className="truncate">{name}</span>
                            )}
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
                            {liveName({
                              ...entry.creator,
                              aiDifficulty: entry.aiDifficulty,
                            })}{" "}
                            <span className="text-muted-foreground">vs</span>{" "}
                            {liveName({
                              ...entry.opponent,
                              aiDifficulty: entry.aiDifficulty,
                            })}
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

function liveName(p: {
  id: string;
  name?: string;
  isAi?: boolean;
  /** The bot's level, when the caller has the entry's difficulty at hand. */
  aiDifficulty?: string;
}): string {
  if (p.isAi || p.id === AI_PLAYER_ID) {
    // Name the SPECIFIC Grandmaster on the board — the brand alone made every
    // live row read identically. aiLevelFor maps any stored value safely.
    return aiLevelFor(p.aiDifficulty).name;
  }
  if (!p.id) return "Waiting…";
  // Real username when the registry has one, the player's stable handle
  // otherwise — a live row never reads as the bare word "Guest".
  return displayNameFor(p.id, p.name);
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
