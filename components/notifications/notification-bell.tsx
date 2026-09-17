"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, MessageSquare, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { cn } from "@/lib/utils";

/**
 * The notification bell.
 *
 * Every player has one durable inbox (DMs, official broadcasts, and their
 * own support thread's replies). The bell polls unread count on an interval
 * — deliberately a poll, not a socket: message delivery is not latency-
 * critical, and a poll survives every network and hosting condition. Opening
 * the dropdown marks the inbox read on the server; a link goes to the full
 * messages panel on the profile.
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
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationBell() {
  const identity = useIdentity();
  const playerId = identity.playerId;
  const authed = !identity.isGuest && Boolean(identity.username);

  const [unread, setUnread] = useState(0);
  const [messages, setMessages] = useState<MessageEnvelope[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const poll = useCallback(async () => {
    if (!playerId) return;
    try {
      const token = getIdentityToken();
      const res = await fetch(`/api/messages?playerId=${encodeURIComponent(playerId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: MessageEnvelope[]; unread?: number };
      setUnread(data.unread ?? 0);
      setMessages((data.messages ?? []).slice(0, 6));
    } catch {
      // Transient network issue: keep the previous count.
    }
  }, [playerId]);

  useEffect(() => {
    if (!authed) return;
    void poll();
    const t = setInterval(() => void poll(), 30_000);
    return () => clearInterval(t);
  }, [authed, poll]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!authed) return null;

  const markRead = () => {
    setOpen(true);
    if (unread > 0) {
      const token = getIdentityToken();
      void fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId, action: "read" }),
      }).then(() => setUnread(0));
    }
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
        onClick={markRead}
        className="relative"
      >
        <Bell aria-hidden />
        {unread > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 font-mono text-[9px] font-bold text-white"
            aria-hidden
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        /* On a phone the panel is FIXED to the viewport: pinned just under
           the nav with a 0.75rem gutter each side. A viewport-anchored panel
           cannot be pushed off-screen by zoom, narrow widths, or the bar's
           own scroll state, which is exactly how the anchored version kept
           overhanging. From sm up it anchors to the bell again. */
        <div className="animate-fade-in-up fixed inset-x-3 top-[calc(var(--nav-h)+0.5rem)] z-50 max-h-[70dvh] overflow-hidden rounded-lg border border-border/70 bg-popover/95 shadow-elevation-3 backdrop-blur sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 sm:max-h-none sm:w-80">
          <p className="border-b border-border/60 px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Notifications
          </p>
          {messages.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nothing yet. Game invites and official announcements land here.
            </p>
          ) : (
            <ul className="max-h-[min(20rem,55dvh)] divide-y divide-border/50 overflow-y-auto">
              {messages.map((m) => (
                <li key={m.id} className={cn("px-3 py-2.5", m.readAt === null && "bg-primary/[0.06]")}>
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    {m.kind === "broadcast" ? (
                      <Volume2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate">{m.fromName}</span>
                    <span className="ml-auto shrink-0 font-normal text-2xs text-muted-foreground">
                      {timeAgo(m.sentAt)}
                    </span>
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
                    {m.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/profile?tab=messages"
            onClick={() => setOpen(false)}
            className="block border-t border-border/60 px-3 py-2 text-center text-xs font-medium text-primary hover:bg-secondary/40"
          >
            Open messages
          </Link>
        </div>
      )}
    </div>
  );
}
