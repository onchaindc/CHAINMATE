"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";

/**
 * Live unread counts, shared by every header surface.
 *
 * Three distinct counters, WhatsApp-style:
 *   - dmUnread:    player-to-player messages (and official replies) waiting
 *                  in /messages. Shown as the superscript on the hamburger's
 *                  Messages entry, cleared the moment the thread is read.
 *   - bellUnread:  official announcements only. Shown on the bell; DMs never
 *                  inflate it.
 *   - eventUnread: notification events — friend requests, accepted requests,
 *                  challenges. Also shown on the bell: the bell is "things
 *                  that happened", announcements are just one kind.
 *
 * One module-level poller feeds every mounted consumer, so having the bell
 * and the hamburger on screen does not double the request rate. A poll (not
 * a socket) is deliberate: delivery is not latency-critical and a poll
 * survives every network and hosting condition. 10s keeps "they accepted my
 * request" feeling live without stressing the free tier.
 */

interface Counts {
  dmUnread: number;
  bellUnread: number;
  eventUnread: number;
}

const listeners = new Set<(c: Counts) => void>();
let current: Counts = { dmUnread: 0, bellUnread: 0, eventUnread: 0 };
let timer: ReturnType<typeof setInterval> | null = null;
let pollerPlayerId: string | null = null;

interface CountEnvelope {
  kind: "dm" | "support" | "broadcast";
  readAt: number | null;
}

async function fetchCounts(playerId: string): Promise<void> {
  try {
    const token = getIdentityToken();
    const res = await fetch(`/api/messages?playerId=${encodeURIComponent(playerId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      messages?: CountEnvelope[];
      eventUnread?: number;
    };
    const messages = data.messages ?? [];
    const dm = messages.filter((m) => m.kind === "dm" && m.readAt === null).length;
    const bell = messages.filter(
      (m) => (m.kind === "broadcast" || m.kind === "support") && m.readAt === null,
    ).length;
    const eventUnread = Math.max(0, data.eventUnread ?? 0);
    if (dm !== current.dmUnread || bell !== current.bellUnread || eventUnread !== current.eventUnread) {
      current = { dmUnread: dm, bellUnread: bell, eventUnread };
      for (const fn of listeners) fn(current);
    }
  } catch {
    // transient; keep previous counts
  }
}

function startPolling(playerId: string): void {
  if (pollerPlayerId === playerId) return;
  stopPolling();
  pollerPlayerId = playerId;
  void fetchCounts(playerId);
  timer = setInterval(() => void fetchCounts(playerId), 10_000);
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  pollerPlayerId = null;
}

/** Reset counts (identity change / sign-out) and notify listeners. */
export function resetMessageCounts(): void {
  current = { dmUnread: 0, bellUnread: 0, eventUnread: 0 };
  for (const fn of listeners) fn(current);
}

/** Force a refresh right now (e.g. after sending, reading, or a friend action). */
export function refreshMessageCounts(): void {
  if (pollerPlayerId) void fetchCounts(pollerPlayerId);
}

export function useMessageCounts(): Counts {
  const identity = useIdentity();
  const authed = !identity.isGuest && Boolean(identity.username);
  const playerId = identity.playerId;
  const [counts, setCounts] = useState<Counts>(current);

  useEffect(() => {
    const fn = (c: Counts) => setCounts(c);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!authed || !playerId || identity.status === "loading") {
      stopPolling();
      resetMessageCounts();
      return;
    }
    startPolling(playerId);
    return () => {
      // Keep polling while any consumer exists; teardown of one consumer
      // must not kill the shared poller for the others.
      if (listeners.size === 0) stopPolling();
    };
  }, [authed, playerId, identity.status]);

  return counts;
}
