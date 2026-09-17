"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Messages: conversations on the left (real threads, initiated or received),
 * the open thread on the right. Sending files a copy into BOTH inboxes with a
 * recipient id, so a started conversation always appears in the chat list and
 * both directions render. 5s polling keeps it feeling live; the unread badge
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
}

interface SearchRow {
  player_id: string;
  username: string;
  is_guest: boolean;
  rating: number;
  country: string | null;
  games: number;
}

interface Conversation {
  peerId: string;
  peerName: string;
  rating?: number;
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
      const data = (await res.json()) as { messages?: Envelope[] };
      setInbox(data.messages ?? []);
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
        setResults((data.playersSearch ?? []).filter((r) => r.player_id !== identity.playerId));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, authed, identity.playerId]);

  /* Conversations: group DM envelopes by the OTHER side of the exchange,
     oldest copy of my sent message included (that is what makes an
     initiated-but-unanswered chat show up in the list). */
  const conversations = useMemo<Conversation[]>(() => {
    if (!inbox) return [];
    const map = new Map<string, Conversation>();
    for (const m of inbox) {
      if (m.kind !== "dm") continue;
      const peerId =
        m.fromPlayerId === identity.playerId ? (m.toPlayerId ?? null) : m.fromPlayerId;
      if (!peerId) continue;
      const unread = m.kind === "dm" && m.readAt === null && m.fromPlayerId !== identity.playerId;
      const existing = map.get(peerId);
      if (existing) {
        if (m.sentAt > existing.lastAt) {
          existing.lastAt = m.sentAt;
          existing.lastBody = preview(m.body);
        }
        if (unread) existing.unread += 1;
        continue;
      }
      map.set(peerId, {
        peerId,
        peerName: m.fromPlayerId === identity.playerId ? (m.toPlayerId ?? peerId) : m.fromName,
        lastBody: preview(m.body),
        lastAt: m.sentAt,
        unread: unread ? 1 : 0,
      });
    }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
  }, [inbox, identity.playerId]);

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

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
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
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
      <BackLink href="/profile" className="mb-4">
        Back to profile
      </BackLink>
      <PageHeader
        eyebrow="Direct"
        title="Messages"
        description="Pick a player, say hello. Official announcements land in your bell."
      />

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-6">
        {/* Left: search + the conversation list */}
        <div className={cn("space-y-3", peer && "hidden lg:block")}>
          <Panel className="p-3">
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
                {searching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
              </span>
            </label>
            {query.trim().length >= 2 && (
              <ul className="mt-2 space-y-0.5">
                {results.length === 0 && !searching && (
                  <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                    No players found
                  </li>
                )}
                {results.map((r) => (
                  <li key={r.player_id}>
                    <button
                      type="button"
                      onClick={() => openPeer(r)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/50"
                    >
                      <PlayerAvatar name={r.username} size="sm" />
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
            )}

            {/* The chat list: every DM exchange, newest first, unread badge
                like WhatsApp. Sender copies carry the recipient id, so a chat
                the player started themselves shows here too. */}
            <div className="mt-3 border-t border-border/50 pt-2">
              <p className="px-1 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Chats
              </p>
              {inbox === null ? (
                <LoadingRows rows={3} />
              ) : conversations.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No conversations yet
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {conversations.map((c) => (
                    <li key={c.peerId}>
                      <button
                        type="button"
                        onClick={() => openPeer({ player_id: c.peerId, username: c.peerName, is_guest: false, rating: 0, country: null, games: 0 })}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/50",
                          peer?.player_id === c.peerId && "bg-secondary/60",
                        )}
                      >
                        <PlayerAvatar name={c.peerName} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium">{c.peerName}</span>
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
            </div>
          </Panel>

          {/* Official announcements, always visible in the room */}
          {inbox?.filter((m) => m.kind === "broadcast").length ? (
            <Panel className="p-3">
              <p className="px-1 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Announcements
              </p>
              <ul className="space-y-2">
                {inbox
                  .filter((m) => m.kind === "broadcast")
                  .slice(0, 5)
                  .map((m) => (
                    <li key={m.id} className="rounded-md bg-primary/5 px-2.5 py-2">
                      <p className="text-xs leading-snug text-foreground/90">{m.body}</p>
                      <p className="mt-1 text-2xs text-muted-foreground">{timeLabel(m.sentAt)}</p>
                    </li>
                  ))}
              </ul>
            </Panel>
          ) : null}
        </div>

        {/* Right: the conversation */}
        <Panel className={cn("flex min-h-[28rem] flex-col p-0", !peer && "hidden lg:flex")}>
          {peer ? (
            <>
              <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden"
                  aria-label="Back to chats"
                  onClick={() => setPeer(null)}
                >
                  <ArrowLeft aria-hidden />
                </Button>
                <PlayerAvatar name={peer.username} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{peer.username}</p>
                  {peer.rating > 0 && (
                    <p className="text-2xs text-muted-foreground">{peer.rating} rated</p>
                  )}
                </div>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
                {thread.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    No messages yet. Say hello.
                  </p>
                ) : (
                  thread.map((m) => {
                    const mine = m.fromPlayerId === identity.playerId;
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-snug",
                          mine ? "ml-auto bg-primary/15 text-foreground" : "bg-secondary/60 text-foreground/90",
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.body}</p>
                        <p className="mt-1 text-right text-2xs text-muted-foreground">
                          {timeLabel(m.sentAt)}
                        </p>
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
                  className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
                />
                <Button type="submit" size="icon" disabled={!draft.trim() || sending} aria-label="Send">
                  {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                </Button>
              </form>
              {error && (
                <p className="border-t border-border/60 px-4 py-2 text-xs text-destructive">{error}</p>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={MessagesSquare}
                title="Pick a conversation"
                description="Search for a player on the left and start chatting."
              />
            </div>
          )}
        </Panel>
      </div>

      {inbox === null && (
        <Panel className="mt-6 lg:hidden">
          <LoadingRows rows={4} />
        </Panel>
      )}
    </div>
  );
}
