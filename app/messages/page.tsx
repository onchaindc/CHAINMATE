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
import { cn } from "@/lib/utils";

/**
 * Messages: one clean room. A player search on the left, a conversation on
 * the right, nothing else. Pick a player, type, send. Every player also sees
 * official ChainMate announcements inline at the top of the list.
 */

interface Envelope {
  id: string;
  fromPlayerId: string;
  fromName: string;
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

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
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
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [authed, load]);

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

  const thread = useMemo(() => {
    if (!inbox || !peer) return [];
    return inbox
      .filter((m) => m.kind === "dm" && m.fromPlayerId === peer.player_id)
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
      }
    } catch {
      setError("Could not send the message");
    } finally {
      setSending(false);
    }
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
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <BackLink href="/profile" className="mb-4">
        Back to profile
      </BackLink>
      <PageHeader
        eyebrow="Direct"
        title="Messages"
        description="Pick a player, say hello. Official announcements land in your bell."
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-6">
        {/* Left: search + announcements */}
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
                      onClick={() => {
                        setPeer(r);
                        setQuery("");
                        setResults([]);
                        setError(null);
                      }}
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
                  aria-label="Back to search"
                  onClick={() => setPeer(null)}
                >
                  <ArrowLeft aria-hidden />
                </Button>
                <PlayerAvatar name={peer.username} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{peer.username}</p>
                  <p className="text-2xs text-muted-foreground">{peer.rating} rated</p>
                </div>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
                {thread.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    No messages yet. Say hello.
                  </p>
                ) : (
                  thread.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-snug",
                        m.fromPlayerId === identity.playerId
                          ? "ml-auto bg-primary/15 text-foreground"
                          : "bg-secondary/60 text-foreground/90",
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className="mt-1 text-right text-2xs text-muted-foreground">
                        {timeLabel(m.sentAt)}
                      </p>
                    </div>
                  ))
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
