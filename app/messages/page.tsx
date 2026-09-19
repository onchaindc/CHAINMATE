"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, MessagesSquare, Search, Send } from "lucide-react";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { refreshMessageCounts } from "@/hooks/use-message-counts";
import { cn } from "@/lib/utils";

/**
 * Messages: conversations on the left, the open thread on the right — the
 * shape every chat app uses. On desktop the two panes are true columns that
 * fill the viewport height with the thread scrolling internally (no more
 * floating panels lost in a page of whitespace). On a phone one pane shows
 * at a time. Avatars come from the server on every envelope, so chats show
 * faces, not initials. 5s polling keeps it feeling live; the unread badge
 * per conversation clears the moment you open it.
 */

interface Envelope {
  id: string;
  fromPlayerId: string;
  fromName: string;
  toPlayerId?: string | null;
  kind: "dm" | "support" | "broadcast";
  body: string;
  sentAt: number;
  readAt: number | null;
  /** Server-resolved display name for the OTHER side (never a raw id). */
  counterpartName?: string;
  counterpartId?: string;
  /** The other side's uploaded picture (server-resolved). */
  counterpartAvatar?: string | null;
}

interface SearchRow {
  player_id: string;
  username: string;
  is_guest: boolean;
  rating: number;
  country: string | null;
  games: number;
  avatar_url?: string | null;
}

interface Conversation {
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  rating: number;
  lastBody: string;
  lastAt: number;
  unread: number;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}

export default function MessagesPage() {
  const identity = useIdentity();
  const authed = !identity.isGuest && Boolean(identity.username);

  const [inbox, setInbox] = useState<Envelope[] | null>(null);
  /** The friends this account may chat with (server decides, not the UI). */
  const [allowedPeers, setAllowedPeers] = useState<Set<string>>(new Set());
  const [peer, setPeer] = useState<SearchRow | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!identity.playerId) return;
    try {
      const token = getIdentityToken();
      const res = await fetch(
        `/api/messages?playerId=${encodeURIComponent(identity.playerId)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages?: Envelope[];
        allowedPeers?: string[];
      };
      setInbox(data.messages ?? []);
      setAllowedPeers(new Set(data.allowedPeers ?? []));
    } catch {
      // transient; keep the previous list
    }
  }, [identity.playerId]);

  useEffect(() => {
    if (!authed) return;
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [authed, load]);

  /* When a conversation is open, mark the DM inbox read so the badge clears
     like a seen WhatsApp thread (both header badges refresh instantly). */
  useEffect(() => {
    if (!peer || !authed) return;
    const token = getIdentityToken();
    void fetch("/api/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ playerId: identity.playerId, action: "read-dm" }),
    }).then(() => refreshMessageCounts());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer?.player_id, authed]);

  /* Player search, debounced. */
  useEffect(() => {
    if (!authed) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/players/search?q=${encodeURIComponent(q)}&viewer=${encodeURIComponent(identity.playerId ?? "")}`,
        );
        const data = (await res.json()) as { playersSearch?: SearchRow[] };
        // Messaging is friends-only: the search offers exactly the players
        // this account can actually chat with, nothing else.
        setResults(
          (data.playersSearch ?? []).filter(
            (r) => r.player_id !== identity.playerId && allowedPeers.has(r.player_id),
          ),
        );
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, authed, identity.playerId, allowedPeers]);

  /* Conversations: group DM envelopes by the OTHER side of the exchange,
     oldest copy of my sent message included (that is what makes an
     initiated-but-unanswered chat show up in the list). Names and avatars
     are the SERVER-RESOLVED counterpart fields on every envelope. */
  const conversations = useMemo<Conversation[]>(() => {
    if (!inbox) return [];
    const map = new Map<string, Conversation>();
    for (const m of inbox) {
      if (m.kind !== "dm") continue;
      const mine = m.fromPlayerId === identity.playerId;
      const peerId = m.counterpartId ?? (mine ? (m.toPlayerId ?? null) : m.fromPlayerId);
      if (!peerId) continue;
      // Friends-only: the server sends the allowlist; the UI mirrors it.
      if (!allowedPeers.has(peerId)) continue;
      const unread = m.kind === "dm" && m.readAt === null && m.fromPlayerId !== identity.playerId;
      const peerName =
        m.counterpartName && m.counterpartName !== "You"
          ? m.counterpartName
          : m.fromName && m.fromName !== "You"
            ? m.fromName
            : peerId;
      const peerAvatar = m.counterpartAvatar ?? null;
      const existing = map.get(peerId);
      if (existing) {
        if (m.sentAt > existing.lastAt) {
          existing.lastAt = m.sentAt;
          existing.lastBody = preview(m.body);
        }
        if (unread) existing.unread += 1;
        // First envelope wins the avatar, but heal a missing one: a later
        // envelope may carry the picture an older one predates.
        if (!existing.peerAvatar && peerAvatar) {
          existing.peerAvatar = peerAvatar;
          existing.peerName = peerName;
        }
        continue;
      }
      map.set(peerId, {
        peerId,
        // The thread title is the peer's name. "You" and raw acct_… ids are
        // equally wrong here; the server resolves real names (see
        // lib/server/messages.ts).
        peerName,
        peerAvatar,
        rating: 0,
        lastBody: preview(m.body),
        lastAt: m.sentAt,
        unread: unread ? 1 : 0,
      });
    }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
  }, [inbox, identity.playerId, allowedPeers]);

  const thread = useMemo(() => {
    if (!inbox || !peer) return [];
    return inbox
      .filter(
        (m) =>
          m.kind === "dm" &&
          (m.fromPlayerId === peer.player_id || m.toPlayerId === peer.player_id),
      )
      .sort((a, b) => a.sentAt - b.sentAt);
  }, [inbox, peer]);

  /** Avatar for the open thread's header + bubbles (envelopes carry it). */
  const peerAvatar = useMemo(() => {
    if (!peer) return null;
    const hit = inbox?.find(
      (m) =>
        m.kind === "dm" &&
        (m.counterpartId === peer.player_id ||
          m.fromPlayerId === peer.player_id ||
          m.toPlayerId === peer.player_id),
    );
    return hit?.counterpartAvatar ?? peer.avatar_url ?? null;
  }, [inbox, peer]);

  useEffect(() => {
    /* Scroll the THREAD viewport internally — never scrollIntoView, which
       walks up to the nearest scrollable ancestor chain and yanks the whole
       page (the reported "chat makes the page jump"). The thread pane is the
       element with overflow here, so setting its scrollTop pins the newest
       bubble into view without touching the window. */
    const el = threadEndRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length, peer]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !peer || sending) return;
    setSending(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          playerId: identity.playerId,
          action: "send",
          toPlayerId: peer.player_id,
          body: text,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Could not send the message");
      } else {
        setDraft("");
        await load();
        refreshMessageCounts();
      }
    } catch {
      setError("Could not send the message");
    } finally {
      setSending(false);
    }
  };

  const openPeer = (row: SearchRow) => {
    setPeer(row);
    setQuery("");
    setResults([]);
    setError(null);
  };

  if (!authed) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <Panel className="p-8">
          <EmptyState
            icon={MessagesSquare}
            title="Sign in to use messages"
            description="Messages are part of your ChainMate account. Create one in seconds from the menu."
            action={{ href: "/auth", label: "Sign in" }}
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-var(--nav-h))] w-full max-w-6xl flex-col px-0 sm:px-4 lg:px-6">
      {/* Desktop header row: compact, app-like. The phone keeps its own
          header inside the list pane (only one pane is visible there). */}
      <div className="hidden items-end justify-between gap-4 px-0 pt-6 lg:flex">
        <PageHeader eyebrow="Direct" title="Messages" />
        <BackLink href="/profile" className="mb-1">
          Back to profile
        </BackLink>
      </div>

      <div className="grid min-h-0 flex-1 gap-0 sm:gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-5 lg:pb-6">
        {/* Left pane: search + the conversation list */}
        <div className={cn("flex min-h-0 flex-col sm:p-0", peer && "hidden lg:flex")}>
          <Panel className="flex min-h-0 flex-1 flex-col gap-0 rounded-none border-x-0 sm:rounded-lg sm:border-x lg:mb-0">
            <div className="border-b border-border/60 p-3">
              <label className="block">
                <span className="sr-only">Search players</span>
                <span className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2">
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a player"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  {searching && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />
                  )}
                </span>
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {query.trim().length >= 2 ? (
                <ul className="p-2">
                  {results.length === 0 && !searching && (
                    <li className="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                      {allowedPeers.size === 0
                        ? "Messaging is for friends. Add friends from your profile, then chat here."
                        : "No friends match that search"}
                    </li>
                  )}
                  {results.map((r) => (
                    <li key={r.player_id}>
                      <button
                        type="button"
                        onClick={() => openPeer(r)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/50"
                      >
                        <PlayerAvatar name={r.username} avatarUrl={r.avatar_url} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{r.username}</span>
                          <span className="block text-2xs text-muted-foreground">
                            {r.rating} rated · {r.games} games
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <p className="px-4 pb-1.5 pt-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Chats
                  </p>
                  {inbox === null ? (
                    <LoadingRows rows={5} />
                  ) : conversations.length === 0 ? (
                    <p className="px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                      No conversations yet. Find a friend above and say hello.
                    </p>
                  ) : (
                    <ul className="p-1.5">
                      {conversations.map((c) => (
                        <li key={c.peerId}>
                          <button
                            type="button"
                            onClick={() =>
                              openPeer({
                                player_id: c.peerId,
                                username: c.peerName,
                                is_guest: false,
                                rating: c.rating,
                                country: null,
                                games: 0,
                                avatar_url: c.peerAvatar,
                              })
                            }
                            className={cn(
                              "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-secondary/50",
                              peer?.player_id === c.peerId && "bg-secondary/60",
                            )}
                          >
                            <PlayerAvatar name={c.peerName} avatarUrl={c.peerAvatar} size="md" />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-sm font-semibold">
                                  {c.peerName}
                                </span>
                                <span className="shrink-0 text-2xs text-muted-foreground">
                                  {timeLabel(c.lastAt)}
                                </span>
                              </span>
                              <span className="flex items-center justify-between gap-2">
                                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                  {c.lastBody}
                                </span>
                                {c.unread > 0 && (
                                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-2xs font-bold text-primary-foreground">
                                    {c.unread}
                                  </span>
                                )}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </Panel>
        </div>

        {/* Right pane: the conversation */}
        <Panel
          className={cn(
            "flex min-h-0 flex-1 flex-col rounded-none border-x-0 p-0 sm:rounded-lg sm:border-x lg:mb-6",
            !peer && "hidden lg:flex",
          )}
        >
          {peer ? (
            <>
              <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
                {/* Back to the thread list. On phones this leaves the chat;
                    on desktop it returns to the pick-a-conversation state —
                    the back affordance the threads header had but the chat
                    itself was missing. */}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Back to chats"
                  onClick={() => setPeer(null)}
                >
                  <ArrowLeft aria-hidden />
                </Button>
                <PlayerAvatar name={peer.username} avatarUrl={peerAvatar} size="md" />
                <div className="min-w-0">
                  {/* The name is their profile link, matching the friends
                      list: a chat header is where you look someone up. */}
                  {peer.username && !peer.is_guest ? (
                    <Link
                      href={`/players/${encodeURIComponent(peer.username)}`}
                      className="block truncate text-sm font-semibold underline-offset-2 hover:underline"
                    >
                      {peer.username}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-semibold">{peer.username}</p>
                  )}
                  {peer.rating > 0 && (
                    <p className="text-2xs text-muted-foreground">{peer.rating} rated</p>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-4">
                {thread.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No messages yet. Say hello.
                  </p>
                ) : (
                  thread.map((m) => {
                    const mine = m.fromPlayerId === identity.playerId;
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          "flex items-end gap-2",
                          mine ? "justify-end" : "justify-start",
                        )}
                      >
                        {!mine && (
                          <PlayerAvatar
                            name={m.counterpartName ?? peer.username}
                            avatarUrl={m.counterpartAvatar ?? peerAvatar}
                            size="xs"
                            className="mb-0.5"
                          />
                        )}
                        <div
                          className={cn(
                            "max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-snug",
                            mine
                              ? "rounded-br-md bg-primary/20 text-foreground"
                              : "rounded-bl-md bg-secondary/70 text-foreground/90",
                          )}
                        >
                          <p className="whitespace-pre-wrap break-words">{m.body}</p>
                          <p
                            className={cn(
                              "mt-1 text-right text-2xs text-muted-foreground",
                              mine && "text-primary/70",
                            )}
                          >
                            {timeLabel(m.sentAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={threadEndRef} />
              </div>
              <form
                className="flex items-center gap-2 border-t border-border/60 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={2000}
                  placeholder={`Message ${peer.username}`}
                  className="min-w-0 flex-1 rounded-full border border-border/70 bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-primary/50"
                />
                <Button
                  type="submit"
                  size="icon"
                  className="rounded-full"
                  disabled={!draft.trim() || sending}
                  aria-label="Send"
                >
                  {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                </Button>
              </form>
              {error && (
                <p className="border-t border-border/60 px-4 py-2 text-xs text-destructive">{error}</p>
              )}
            </>
          ) : (
            <div className="hidden flex-1 items-center justify-center p-6 lg:flex">
              <EmptyState
                icon={MessagesSquare}
                title="Pick a conversation"
                description="Chats are between friends. Add friends from your profile, then pick one here."
              />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
