"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Gamepad2,
  Loader2,
  Swords,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { ProfileBadge, ProfileHeader } from "@/components/profile/profile-header";
import { RecentForm } from "@/components/profile/recent-form";
import { StatTiles, formatStreak } from "@/components/profile/stat-tiles";
import { useIdentity } from "@/lib/identity-context";
import { guestDisplayName } from "@/lib/identity";
import { getStore } from "@/lib/store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { isPlayedGame, type GameState, type PlayerStats } from "@/lib/types";

export default function PublicPlayerPage() {
  const params = useParams<{ username: string }>();
  const username = decodeURIComponent(params.username);
  const router = useRouter();
  const identity = useIdentity();

  const [player, setPlayer] = useState<{
    playerId: string;
    username: string;
    isGuest: boolean;
    country: string | null;
    rating: number;
    peakRating: number;
    wins: number;
    losses: number;
    draws: number;
    games: number;
    currentStreak: number;
    bestStreak: number;
  } | null>(null);
  const [games, setGames] = useState<GameState[]>([]);
  /**
   * The player's rating record. Served alongside the profile all along — and
   * thrown away here, which is why the public page showed a current rating and
   * nothing about how it got there while `ratingHistory` sat unused in the
   * response.
   */
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});
  const [friends, setFriends] = useState<PlayerStats[]>([]);
  const [friendship, setFriendship] = useState<"none" | "requested" | "incoming" | "friends">(
    "none",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenging, setChallenging] = useState(false);

  const store = useMemo(() => getStore("hosted") as HostedGameStore, []);
  const viewerId = identity.playerId;
  const isMe = player !== null && player.playerId === viewerId;

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  /**
   * Rating change per game, for the history rows.
   *
   * The game's own stamp wins over the stats history: `ratings` is written onto
   * the game when it is rated and stays there, while the history is a recent
   * window and can be missing older entries.
   */
  const deltas = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of stats?.ratingHistory ?? []) map.set(h.gameId, h.change);
    if (player) {
      for (const g of games) {
        const change = g.ratings?.[player.playerId]?.change;
        if (change !== undefined) map.set(g.id, change);
      }
    }
    return map;
  }, [stats?.ratingHistory, games, player]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await store.publicProfile(username);
      setPlayer(data.player);
      setStats(data.stats);
      setGames(data.games.filter(isPlayedGame));
      setPlayers(data.players);
      setFriends(data.friends);
      setFriendship(data.friendship);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profile");
    }
  }, [store, username]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (
    action: "request" | "accept" | "decline" | "remove",
    otherId: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await store.friendAction(action, otherId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work — try again.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Challenge this player. This used to open an ordinary public game, which
   * addressed nobody: the person being "challenged" was never told, and anyone
   * could walk into the board first. Now it sends a real invitation that only
   * they can accept — it pops up wherever they are in the app
   * (components/game/challenge-inbox.tsx) — and takes us to the board to wait
   * for their answer.
   */
  const challenge = async () => {
    if (!player) return;
    setChallenging(true);
    setError(null);
    try {
      const game = await store.challenge(player.playerId, "10 + 0");
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the challenge.");
      setChallenging(false);
    }
  };

  if (error && !player) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-24 sm:px-6">
        <EmptyState
          icon={UserX}
          title="Player not found"
          description={error}
          action={{ href: "/leaderboard", label: "Browse the leaderboard" }}
        />
      </div>
    );
  }

  if (!player) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <div className="space-y-4">
          <div className="h-16 animate-pulse rounded-lg bg-secondary/60" />
          {/* Matches the 5-up stat grid it stands in for, so the page doesn't
              reflow into a different shape when the data lands. */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 sm:grid-cols-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-[4.5rem] animate-pulse bg-card/50"
                style={{ animationDelay: `${i * 90}ms` }}
              />
            ))}
          </div>
          <Panel>
            <LoadingRows rows={4} />
          </Panel>
        </div>
      </div>
    );
  }

  const winRate =
    player.games > 0 ? Math.round((player.wins / player.games) * 100) : null;
  const streak = player.currentStreak ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <ProfileHeader
        name={player.username}
        eyebrow="Player"
        country={player.country}
        rating={player.rating}
        ratingDelta={stats?.ratingHistory?.[0]?.change ?? null}
        isGuest={player.isGuest}
        description={
          <>
            {player.isGuest ? "Guest player" : "ChainMate player"}
            {player.games > 0
              ? ` · ${player.games} game${player.games === 1 ? "" : "s"} played`
              : ""}
          </>
        }
        badges={isMe && <ProfileBadge tone="primary">You</ProfileBadge>}
        actions={
          !isMe && (
            <>
              {friendship === "none" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("request", player.playerId)}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  Add friend
                </Button>
              )}
              {friendship === "requested" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("remove", player.playerId)}
                >
                  <UserMinus className="h-3.5 w-3.5" aria-hidden />
                  Request sent
                </Button>
              )}
              {friendship === "incoming" && (
                <>
                  <Button size="sm" disabled={busy} onClick={() => void act("accept", player.playerId)}>
                    <UserCheck className="h-3.5 w-3.5" aria-hidden />
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act("decline", player.playerId)}
                  >
                    Decline
                  </Button>
                </>
              )}
              {friendship === "friends" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("remove", player.playerId)}
                >
                  <UserCheck className="h-3.5 w-3.5" aria-hidden />
                  Friends
                </Button>
              )}
              <Button size="sm" disabled={challenging} onClick={() => void challenge()}>
                {challenging ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Swords className="h-3.5 w-3.5" aria-hidden />
                )}
                Challenge
              </Button>
            </>
          )
        }
      />

      {error && <ErrorNote message={error} onRetry={() => void load()} className="mt-5" />}

      <StatTiles
        layout="five"
        className="mt-8 animate-fade-in-up"
        tiles={[
          { label: "Games", value: String(player.games) },
          { label: "Wins", value: String(player.wins) },
          { label: "Losses", value: String(player.losses) },
          { label: "Draws", value: String(player.draws) },
          { label: "Win rate", value: winRate !== null ? `${winRate}%` : "—" },
        ]}
      />

      <StatTiles
        layout="three"
        size="sm"
        className="mt-4 animate-fade-in-up [animation-delay:80ms]"
        tiles={[
          { label: "Peak rating", value: String(player.peakRating) },
          formatStreak(streak),
          { label: "Best streak", value: `${player.bestStreak}W` },
        ]}
      />

      {/* Form — the shape of the record the tiles above only total up. */}
      <RecentForm
        history={stats?.ratingHistory}
        games={games}
        playerId={player.playerId}
        streak={streak}
        showTrend
        className="mt-4 [animation-delay:100ms]"
      />

      {/* Friends */}
      <div className="mt-10 animate-fade-in-up [animation-delay:120ms]">
        <SectionLabel aside={friends.length > 0 ? String(friends.length) : undefined}>
          Friends
        </SectionLabel>
        {friends.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {player.username} hasn&rsquo;t added any friends yet.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {friends.map((f) => (
              <li
                key={f.playerId}
                className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/50 py-1 pl-1.5 pr-3 text-xs"
              >
                <PlayerAvatar name={f.username ?? "?"} size="xs" />
                <CountryFlag code={f.country} />
                {!f.isGuest && f.username ? (
                  /* `next/link`, not a bare anchor: this is an internal route,
                     and an <a> made every friend a full document reload. */
                  <Link
                    href={`/players/${encodeURIComponent(f.username)}`}
                    className="font-medium text-foreground/90 underline-offset-2 hover:underline"
                  >
                    {f.username}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {guestDisplayName(f.username)}
                  </span>
                )}
                <span className="font-mono tabular-nums text-primary">{f.rating}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent games */}
      <div className="mt-10 animate-fade-in-up [animation-delay:160ms]">
        <SectionLabel>Recent games</SectionLabel>
        <Panel className="mt-3">
          {games.length === 0 ? (
            <EmptyState
              icon={Gamepad2}
              title="No games yet"
              description={`${player.username} hasn’t finished a match yet.`}
              className="py-12"
            />
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {games.slice(0, 10).map((game) => (
                <GameRow
                  key={game.id}
                  game={game}
                  me={viewerId}
                  delta={deltas.get(game.id) ?? null}
                  names={names}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
