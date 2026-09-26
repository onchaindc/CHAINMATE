"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Ban, Check, Search, UserMinus, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { CountryFlag } from "@/components/ui/country-flag";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { GUEST_NAME, guestDisplayName } from "@/lib/identity";
import { cn } from "@/lib/utils";
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
  /** Friend pending removal: the dialog names them before anything happens. */
  const [removing, setRemoving] = useState<PlayerStats | null>(null);
  /** Player pending a block (or unblock): the dialog names them first. */
  const [blocking, setBlocking] = useState<PlayerStats | null>(null);
  /** The viewer's blocked ids — drives the Unblock vs Block label. */
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

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
    try {
      setBlockedIds(new Set(await store.blocked()));
    } catch {
      // The list is decorative until an action needs it; a failure here
      // must not blank the friends list.
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
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  /** Removal is destructive and deserves a named confirmation: removing a
      friend cuts their chat access too (messaging is friends-only). */
  const confirmRemove = async () => {
    if (!removing) return;
    const target = removing;
    setRemoving(null);
    await act("remove", target.playerId);
  };

  /** Block (or unblock) after the confirm dialog has been accepted. */
  const confirmBlock = async () => {
    if (!blocking) return;
    const target = blocking;
    const willBlock = !blockedIds.has(target.playerId);
    setBlocking(null);
    setBusyId(target.playerId);
    setError(null);
    try {
      if (willBlock && !target.isGuest) {
        // Blocking removes the friendship too: a blocked "friend" is a
        // contradiction, and the block already cuts their messaging rights.
        await store.friendAction("remove", target.playerId).catch(() => undefined);
      }
      await store.blockAction(willBlock ? "block" : "unblock", target.playerId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const friendRow = (
    p: PlayerStats,
    actions?: React.ReactNode,
    options?: { withMenu?: boolean },
  ) => {
    const linkable = !p.isGuest && p.username;
    const name = guestDisplayName(p.username) || GUEST_NAME;
    const isBlocked = blockedIds.has(p.playerId);
    return (
      <div
        key={p.playerId}
        className="group flex items-center gap-3 px-3 py-2"
      >
        <PlayerAvatar name={name} avatarUrl={p.avatarUrl} size="sm" />
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
            {isBlocked && (
              <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-destructive">
                blocked
              </span>
            )}
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            <span className="font-mono tabular-nums text-primary">{p.rating}</span>
            {!p.isGuest && p.games > 0 ? ` · ${p.games} games` : p.isGuest ? " · guest" : ""}
          </p>
        </div>
        {/* Row actions — quiet icon buttons: block/unblock and remove.
            Always visible on touch (no hover there), hover-revealed on
            desktop so the list stays clean and destructive actions can't
            be hit by accident. */}
        {options?.withMenu && (
          <div className="flex shrink-0 items-center gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button
              type="button"
              aria-label={isBlocked ? `Unblock ${name}` : `Block ${name}`}
              disabled={busyId === p.playerId}
              onClick={() => setBlocking(p)}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60",
                isBlocked ? "text-destructive hover:text-destructive" : "hover:text-foreground",
                "disabled:opacity-40",
              )}
            >
              <Ban className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Remove ${name} from friends`}
              disabled={busyId === p.playerId}
              onClick={() => setRemoving(p)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-40"
            >
              <UserMinus className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
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
                <PlayerAvatar name={r.username} avatarUrl={r.avatar_url} size="sm" />
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
                  variant={r.friendship === "none" ? "outline" : "ghost"}
                  disabled={busyId === r.player_id || r.friendship !== "none"}
                  onClick={() => void act("request", r.player_id)}
                >
                  {r.friendship === "none" ? (
                    <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                  )}
                  {r.friendship === "none"
                    ? "Add"
                    : r.friendship === "requested"
                      ? "Sent"
                      : r.friendship === "incoming"
                        ? "Wants to add you"
                        : "Friends"}
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
            description="Search above to send a request."
            className="py-8"
          />
        ) : (
          <div className="divide-y divide-border/50 py-1">
            {friends.map((p) => friendRow(p, undefined, { withMenu: true }))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing ? guestDisplayName(removing.username) || GUEST_NAME : GUEST_NAME}?`}
        confirmLabel="Remove friend"
        destructive
        busy={removing !== null && busyId === removing.playerId}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      >
        They will no longer appear in your friends list, and you will not be
        able to message each other. You can always add them again later.
      </ConfirmDialog>

      {/* Block (or unblock) — a moderation shield, so it is named and
          confirmed like every other destructive action. */}
      <ConfirmDialog
        open={blocking !== null}
        title={
          blockedIds.has(blocking?.playerId ?? "")
            ? `Unblock ${blocking ? guestDisplayName(blocking.username) || GUEST_NAME : GUEST_NAME}?`
            : `Block ${blocking ? guestDisplayName(blocking.username) || GUEST_NAME : GUEST_NAME}?`
        }
        confirmLabel={blockedIds.has(blocking?.playerId ?? "") ? "Unblock" : "Block"}
        destructive={!blockedIds.has(blocking?.playerId ?? "")}
        busy={blocking !== null && busyId === blocking.playerId}
        onCancel={() => setBlocking(null)}
        onConfirm={() => void confirmBlock()}
      >
        {blockedIds.has(blocking?.playerId ?? "") ? (
          <p>
            They will be able to message you, challenge you and add you as a
            friend again.
          </p>
        ) : (
          <p>
            They will no longer be able to message you, challenge you or add
            you as a friend. You can still challenge them, and you can unblock
            at any time. If you are friends, this also removes the friendship.
          </p>
        )}
      </ConfirmDialog>
    </Panel>
  );
}
