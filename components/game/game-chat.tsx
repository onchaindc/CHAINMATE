"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { cn } from "@/lib/utils";

/**
 * Chat between the two players inside one game.
 *
 * Entry is a single chat icon — the conversation is opt-in, not a permanent
 * panel bolted under the moves list. The exchange is deliberately EPHEMERAL:
 * the server erases it the moment the game reaches a terminal state (see
 * writeGame in lib/server/hosted.ts) and never mirrors it to durable storage,
 * so what is said during a match stays in the match.
 *
 * There is no "Loading chat…" state: the icon opens instantly, and the thread
 * simply reads empty until the first poll answers. That kills the stuck
 * "Loading chat…" screen (an unanswered or slow poll previously locked the
 * panel in a spinner-adjacent state forever).
 */

interface ChatMessage {
  id: string;
  fromPlayerId: string;
  fromName: string;
  body: string;
  sentAt: number;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function GameChat({
  gameId,
  enabled,
  className,
}: {
  gameId: string;
  /** False for spectators, AI games, and unjoined waiting rooms. */
  enabled: boolean;
  className?: string;
}) {
  const identity = useIdentity();
  const playerId = identity.playerId;

  const [open, setOpen] = useState(false);
  // null = not fetched yet, [] = fetched and empty. Renders identically
  // (an inviting "no messages yet" line) — no loading gate, ever.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(0);

  const poll = useCallback(async () => {
    try {
      const token = getIdentityToken();
      const res = await fetch(
        `/api/games/${encodeURIComponent(gameId)}/chat?playerId=${encodeURIComponent(playerId)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: ChatMessage[] };
      const next = data.messages ?? [];
      // Grow-only check keeps scroll position stable when nothing arrived.
      if (next.length !== countRef.current) {
        countRef.current = next.length;
        setMessages(next);
      }
    } catch {
      // Transient — the next poll catches up.
    }
  }, [gameId, playerId]);

  // Poll only while the panel is open — a closed icon costs nothing.
  useEffect(() => {
    if (!enabled || !open || !playerId) return;
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => clearInterval(t);
  }, [enabled, open, playerId, poll]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId, body: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to send");
      setDraft("");
      await poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  if (!enabled) return null;

  // Collapsed: just the icon, aligned with the panel's other section headers.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open game chat"
        className={cn(
          "flex items-center gap-2 border-t border-border/60 px-4 py-2.5 text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        <MessageCircle className="h-3.5 w-3.5" aria-hidden />
        <span className="text-2xs font-semibold uppercase tracking-wider">Chat</span>
      </button>
    );
  }

  return (
    <div className={cn("border-t border-border/60", className)}>
      <div className="flex items-center gap-2 px-4 py-2">
        <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Chat
        </span>
        <span className="ml-auto text-2xs text-muted-foreground/70">
          Gone when the game ends
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close game chat"
          className="ml-1 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div ref={listRef} className="max-h-44 space-y-1.5 overflow-y-auto px-4 pb-2">
        {messages.length === 0 ? (
          <p className="py-3 text-center text-2xs text-muted-foreground">
            Say hello. Only you two can see this.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.fromPlayerId === playerId;
            return (
              <div key={m.id} className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                <p className="text-2xs text-muted-foreground">
                  {mine ? "You" : m.fromName}
                  <span className="ml-1.5 opacity-70">{timeLabel(m.sentAt)}</span>
                </p>
                <p
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 text-xs leading-snug",
                    mine
                      ? "bg-primary/15 text-foreground"
                      : "bg-secondary/50 text-foreground/90",
                  )}
                >
                  {m.body}
                </p>
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border/50 p-2.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message your opponent…"
          maxLength={500}
          className="h-8 flex-1 text-xs"
        />
        <Button size="icon" className="h-8 w-8" disabled={sending || !draft.trim()} onClick={() => void send()} aria-label="Send chat message">
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
        </Button>
      </div>
      {error && <p className="px-3 pb-2 text-2xs text-destructive">{error}</p>}
    </div>
  );
}
