"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Send, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { EmptyState, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { cn } from "@/lib/utils";

/**
 * The player's messages panel: one durable inbox holding DMs from other
 * players, official ChainMate broadcasts, and replies on their support
 * thread. Sending with no recipient files a support message to the
 * operator; the thread reads like a chat either way.
 */

interface MessageEnvelope {
  id: string;
  fromPlayerId: string;
  fromName: string;
  kind: "dm" | "support" | "broadcast";
  body: string;
  sentAt: number;
  readAt: number | null;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function MessagesPanel({ className }: { className?: string }) {
  const identity = useIdentity();
  const playerId = identity.playerId;
  const authed = !identity.isGuest && Boolean(identity.username);

  const [messages, setMessages] = useState<MessageEnvelope[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!playerId) return;
    try {
      const token = getIdentityToken();
      const res = await fetch(`/api/messages?playerId=${encodeURIComponent(playerId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const data = (await res.json()) as { messages?: MessageEnvelope[] };
      setMessages(data.messages ?? []);
    } catch {
      setMessages((prev) => prev ?? []);
    }
  }, [playerId]);

  useEffect(() => {
    if (!authed) return;
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [authed, load]);

  // Opening the panel marks everything read (the bell count drops).
  useEffect(() => {
    if (!authed || messages === null) return;
    if (!messages.some((m) => m.readAt === null)) return;
    const token = getIdentityToken();
    void fetch("/api/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ playerId, action: "read" }),
    }).catch(() => undefined);
  }, [authed, messages, playerId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const token = getIdentityToken();
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId, action: "send", body: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to send");
      setDraft("");
      setNotice("Sent to ChainMate support");
      setTimeout(() => setNotice(null), 2500);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  if (!authed) {
    return (
      <Panel className={className}>
        <EmptyState
          icon={MessageSquare}
          title="Sign in for messages"
          description="Registered players can message support and receive official announcements."
          className="py-10"
        />
      </Panel>
    );
  }

  return (
    <Panel className={className}>
      <div ref={listRef} className="max-h-96 divide-y divide-border/50 overflow-y-auto">
        {messages === null ? (
          <LoadingRows rows={3} />
        ) : messages.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No messages yet"
            description="Write to support below, or wait for official announcements."
            className="py-10"
          />
        ) : (
          messages.map((m) => (
            <div key={m.id} className={cn("px-4 py-3", m.readAt === null && "bg-primary/[0.05]")}>
              <p className="flex items-center gap-1.5 text-xs font-medium">
                {m.kind === "broadcast" ? (
                  <Volume2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{m.fromName}</span>
                {m.kind === "broadcast" && (
                  <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1 py-px text-2xs font-semibold uppercase tracking-wider text-primary">
                    Announcement
                  </span>
                )}
                <span className="ml-auto shrink-0 font-normal text-2xs text-muted-foreground">
                  {timeAgo(m.sentAt)}
                </span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
                {m.body}
              </p>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border/60 p-3">
        <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Message ChainMate support
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
            placeholder="Describe the problem or question…"
            maxLength={2000}
            className="flex-1"
          />
          <Button size="sm" disabled={sending || draft.trim().length === 0} onClick={() => void send()}>
            {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            Send
          </Button>
        </div>
        {notice && <p className="mt-1.5 text-2xs text-primary">{notice}</p>}
        {error && <p className="mt-1.5 text-2xs text-destructive">{error}</p>}
      </div>
    </Panel>
  );
}
