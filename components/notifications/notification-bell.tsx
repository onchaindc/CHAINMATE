"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Swords, UserCheck, UserPlus, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { cn } from "@/lib/utils";

/**
 * The notification bell: everything that HAPPENED to the player.
 *
 * Two streams, one badge:
 *   - notification events (friend requests, accepted requests, challenges)
 *     — typed, avatar-carrying, tappable rows;
 *   - official announcements (broadcasts).
 *
 * Player-to-player DMs never appear here; they live exclusively in /messages
 * behind the hamburger's Messages entry with their own superscript. Opening
 * the bell marks events + announcements seen on the server, so the badge
 * clears exactly like a seen WhatsApp thread.
 */

interface EventEnvelope {
  id: string;
  type: "friend-request" | "friend-accepted" | "challenge";
  actorPlayerId: string;
  actorName: string;
  body: string;
  href?: string;
  createdAt: number;
  readAt: number | null;
}

interface MessageEnvelope {
  id: string;
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

const EVENT_ICON = {
  "friend-request": UserPlus,
  "friend-accepted": UserCheck,
  challenge: Swords,
} as const;

export function NotificationBell() {
  const identity = useIdentity();
  const playerId = identity.playerId;
  const authed = !identity.isGuest && Boolean(identity.username);
  const { bellUnread, eventUnread } = useMessageCounts();
  const unread = bellUnread + eventUnread;

  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [announcements, setAnnouncements] = useState<MessageEnvelope[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadBody = useCallback(async () => {
    if (!playerId) return;
    try {
      const token = getIdentityToken();
      const res = await fetch(`/api/messages?playerId=${encodeURIComponent(playerId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages?: MessageEnvelope[];
        events?: EventEnvelope[];
      };
      setEvents((data.events ?? []).slice(0, 10));
      setAnnouncements(
        (data.messages ?? []).filter((m) => m.kind === "broadcast").slice(0, 5),
      );
    } catch {
      // transient
    }
  }, [playerId]);

  /* The body loads while open, and re-polls every 10s while open so a fresh
     request appears in the open panel without a close/reopen cycle. */
  useEffect(() => {
    if (!open) return;
    void loadBody();
    const t = setInterval(() => void loadBody(), 10_000);
    return () => clearInterval(t);
  }, [open, loadBody]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!authed) return null;

  const markSeen = () => {
    setOpen(true);
    if (unread > 0) {
      const token = getIdentityToken();
      void fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId, action: "read-events" }),
      }).then(() =>
        // Announcements clear with the feed watermark, as before.
        fetch("/api/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ playerId, action: "read-feed" }),
        }),
      );
    }
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? `${unread} notifications` : "Notifications"}
        onClick={markSeen}
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
          <div className="max-h-[min(24rem,58dvh)] overflow-y-auto">
            {/* Events first: actions waiting on the player outrank news. */}
            {events.length > 0 && (
              <ul className="divide-y divide-border/50">
                {events.map((e) => {
                  const Icon = EVENT_ICON[e.type] ?? Bell;
                  return (
                    <li
                      key={e.id}
                      className={cn("px-3 py-2.5", e.readAt === null && "bg-primary/[0.06]")}
                    >
                      <Link
                        href={e.href ?? "/profile"}
                        onClick={() => setOpen(false)}
                        className="flex items-start gap-2.5"
                      >
                        <span className="relative mt-0.5 shrink-0">
                          <PlayerAvatar name={e.actorName} size="sm" />
                          <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-popover bg-primary text-primary-foreground">
                            <Icon className="h-2 w-2" aria-hidden />
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs leading-snug text-foreground/90">
                            {e.body}
                          </span>
                          <span className="mt-0.5 block text-2xs text-muted-foreground">
                            {timeAgo(e.createdAt)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {announcements.length > 0 && (
              <>
                <p className="border-t border-border/60 px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Announcements
                </p>
                <ul className="divide-y divide-border/50">
                  {announcements.map((m) => (
                    <li
                      key={m.id}
                      className={cn("px-3 py-2.5", m.readAt === null && "bg-primary/[0.06]")}
                    >
                      <p className="flex items-center gap-1.5 text-xs font-medium">
                        <Volume2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                        <span className="truncate">ChainMate</span>
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
              </>
            )}

            {events.length === 0 && announcements.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                Nothing yet. Friend requests, challenges and official announcements land here.
              </p>
            )}
          </div>
          <Link
            href="/messages"
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
