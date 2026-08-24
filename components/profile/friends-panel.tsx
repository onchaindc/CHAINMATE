"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Search, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { guestDisplayName } from "@/lib/identity";
import { HostedGameStore, type SearchPlayerResult } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";

interface FriendsPanelProps {
  store: HostedGameStore;
}

/**
 * Real friends, persisted server-side (never local UI state): incoming
 * requests can be accepted or declined, accepted friends appear for both
 * players, and the player search finds ChainMate accounts by username.
 */
export function FriendsPanel({ store }: FriendsPanelProps) {
  const [friends, setFriends] = useState<PlayerStats[] | null>(null);
  const [incoming, setIncoming] = useState<PlayerStats[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchPlayerResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await store.friends();
      setFriends(data.friends);
      setIncoming(data.incoming);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load friends");
      setFriends([]);
    }
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Debounced username search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await store.searchPlayers(q));
      } catch (err) {
        setResults([]);
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, store]);

  const act = async (action: "request" | "accept" | "decline" | "remove", otherId: string) => {
    setBusyId(otherId);
    setError(null);
    try {
      await store.friendAction(action, otherId);
      await reload();
      // Refresh search results so the row reflects the new status.
      if (query.trim().length >= 2) {
        setResults(await store.searchPlayers(query.trim()));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work — try again.");
    } finally {
      setBusyId(null);
    }
  };

  const friendRow = (p: PlayerStats, actions?: React.ReactNode) => {
    const linkable = !p.isGuest && p.username;
    const name = guestDisplayName(p.username);
    return (
      <div
        key={p.playerId}
        className="flex items-center gap-3 px-3 py-2"
      >
        <PlayerAvatar name={name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            <CountryFlag code={p.country} />
            {linkable ? (
              <Link
                href={`/players/${encodeURIComponent(p.username!)}`}
                className="truncate underline-offset-2 hover:underline"
              >
                {name}
              </Link>
            ) : (
              <span className="truncate">{name}</span>
            )}
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            <span className="font-mono tabular-nums text-primary">{p.rating}</span>
            {!p.isGuest && p.games > 0 ? ` · ${p.games} games` : p.isGuest ? " · guest" : ""}
          </p>
        </div>
        {actions}
      </div>
    );
  };

  return (
    <Panel>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Friends
        </span>
        {friends !== null && (
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            {friends.length}
          </span>
        )}
      </div>

      {/* Inset rather than a full-width row: the panel's own dividers separate
          its sections, and a second flush-edge treatment for the error read as
          another section instead of a notice about the one below it. */}
      {error && (
        <div className="border-t border-border/60 p-3">
          <ErrorNote message={error} />
        </div>
      )}

      {/* Player search */}
      <div className="border-t border-border/60 p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a player by username…"
            className="pl-8 text-sm"
            aria-label="Search players"
          />
        </div>
        {searching && (
          <p className="mt-1.5 text-2xs text-muted-foreground">Searching…</p>
        )}
        {results !== null && results.length === 0 && !searching && (
          <p className="mt-1.5 text-2xs text-muted-foreground">
            No players found for “{query.trim()}”.
          </p>
        )}
        {results !== null && results.length > 0 && (
          <div className="mt-2 divide-y divide-border/50 rounded-md border border-border/60">
            {results.map((r) => (
              <div key={r.player_id} className="flex items-center gap-3 px-3 py-2">
                <PlayerAvatar name={r.username} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    <CountryFlag code={r.country} />
                    <Link
                      href={`/players/${encodeURIComponent(r.username)}`}
                      className="truncate underline-offset-2 hover:underline"
                    >
                      {r.username}
                    </Link>
                    {r.is_guest && (
                      <span className="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground">
                        guest
                      </span>
                    )}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    <span className="font-mono tabular-nums text-primary">{r.rating}</span>
                    {r.games > 0 && <span> · {r.games} games</span>}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === r.player_id}
                  onClick={() => void act("request", r.player_id)}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Incoming requests */}
      {incoming.length > 0 && (
        <div className="border-t border-border/60">
          <p className="px-4 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-primary">
            Friend requests
          </p>
          <div className="divide-y divide-border/50 py-1">
            {incoming.map((p) =>
              friendRow(
                p,
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    disabled={busyId === p.playerId}
                    onClick={() => void act("accept", p.playerId)}
                  >
                    Accept
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Decline ${p.username ?? "request"}`}
                    disabled={busyId === p.playerId}
                    onClick={() => void act("decline", p.playerId)}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>,
              ),
            )}
          </div>
        </div>
      )}

      {/* Friends list */}
      <div className="border-t border-border/60">
        {friends === null ? (
          <LoadingRows rows={2} rowClassName="h-10" className="px-3 py-3" />
        ) : friends.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No friends yet"
            description="Search for a player above and send a request — accepted friends show up here and on their profile."
            className="py-8"
          />
        ) : (
          <div className="divide-y divide-border/50 py-1">
            {friends.map((p) =>
              friendRow(
                p,
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === p.playerId}
                  onClick={() => void act("remove", p.playerId)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  Remove
                </Button>,
              ),
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
