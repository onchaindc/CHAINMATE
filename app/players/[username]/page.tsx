"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertCircle, Loader2, Swords, UserCheck, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { flagFor } from "@/lib/countries";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import type { GameState, PlayerStats } from "@/lib/types";

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

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await store.publicProfile(username);
      setPlayer(data.player);
      setGames(data.games);
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

  const challenge = async () => {
    setChallenging(true);
    setError(null);
    try {
      const game = await store.createGame({ timeControl: "10 + 0", visibility: "public" });
      router.push(`/game/${game.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the challenge.");
      setChallenging(false);
    }
  };

  if (error && !player) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-24 text-center">
        <AlertCircle className="h-9 w-9 text-destructive" aria-hidden />
        <h1 className="font-display mt-4 text-2xl font-bold tracking-tight">Player not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{error}</p>
        <Button className="mt-6" onClick={() => router.push("/profile")}>
          Back to your profile
        </Button>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
        <div className="space-y-3">
          <div className="h-16 animate-pulse rounded-lg bg-secondary/60" />
          <div className="grid grid-cols-5 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 animate-pulse bg-card/50" />
            ))}
          </div>
          <div className="h-48 animate-pulse rounded-lg bg-secondary/60" />
        </div>
      </div>
    );
  }

  const winRate =
    player.games > 0 ? Math.round((player.wins / player.games) * 100) : null;
  const streak = player.currentStreak ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      {/* Header */}
      <div className="animate-fade-in-up flex flex-wrap items-center gap-4">
        <PlayerAvatar name={player.username} size="lg" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            {player.country && (
              <span className="text-xl leading-none" aria-hidden>
                {flagFor(player.country)}
              </span>
            )}
            <h1 className="font-display truncate text-2xl font-bold tracking-tight">
              {player.username}
            </h1>
            {player.isGuest ? (
              <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Guest
              </span>
            ) : (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                Account
              </span>
            )}
            {isMe && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                you
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {player.isGuest ? "Guest player" : "ChainMate player"}
            {player.games > 0 ? ` · ${player.games} game${player.games === 1 ? "" : "s"} played` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!isMe && (
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
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("decline", player.playerId)}>
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
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Swords className="h-3.5 w-3.5" aria-hidden />
                )}
                Challenge to a game
              </Button>
            </>
          )}
          <div className="text-right">
            <p className="font-mono text-2xl font-bold tabular-nums text-primary">
              {player.rating}
            </p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              ELO rating
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-8 grid animate-fade-in-up grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 sm:grid-cols-5">
        {[
          { label: "Games", value: String(player.games) },
          { label: "Wins", value: String(player.wins) },
          { label: "Losses", value: String(player.losses) },
          { label: "Draws", value: String(player.draws) },
          { label: "Win rate", value: winRate !== null ? `${winRate}%` : "—" },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-xl font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid animate-fade-in-up grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 [animation-delay:80ms]">
        {[
          { label: "Peak rating", value: String(player.peakRating) },
          {
            label: "Streak",
            value: streak === 0 ? "—" : `${streak > 0 ? "+" : ""}${streak}`,
          },
          { label: "Best streak", value: `+${player.bestStreak}` },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-lg font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      {/* Friends */}
      <div className="mt-10 animate-fade-in-up [animation-delay:120ms]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Friends <span className="ml-1 font-mono text-primary">{friends.length}</span>
        </h2>
        {friends.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {player.username} hasn&rsquo;t added any friends yet.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {friends.map((f) => (
              <span
                key={f.playerId}
                className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/50 py-1 pl-1.5 pr-3 text-xs"
              >
                <PlayerAvatar name={f.username ?? "?"} size="sm" className="!h-5 !w-5 !text-[9px]" />
                {f.country && <span aria-hidden>{flagFor(f.country)}</span>}
                {!f.isGuest && f.username ? (
                  <a
                    href={`/players/${encodeURIComponent(f.username)}`}
                    className="font-medium text-foreground/90 underline-offset-2 hover:underline"
                  >
                    {f.username}
                  </a>
                ) : (
                  <span className="text-muted-foreground">
                    {f.username ?? `Guest_${f.playerId.slice(0, 4).toUpperCase()}`}
                  </span>
                )}
                <span className="font-mono tabular-nums text-primary">{f.rating}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Recent games */}
      <div className="mt-10 animate-fade-in-up [animation-delay:160ms]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent games
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {games.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <p className="text-sm font-medium text-foreground/85">No games yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {player.username} hasn&rsquo;t finished a match yet.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {games.slice(0, 10).map((game) => (
                <GameRow key={game.id} game={game} me={viewerId} names={names} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
