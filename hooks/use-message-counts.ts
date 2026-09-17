"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";

/**
 * Live unread message counts, shared by every header surface.
 *
 * Two distinct counters, WhatsApp-style:
 *   - dmUnread:   player-to-player messages (and official replies) waiting in
 *                 /messages. Shown as the superscript on the hamburger's
 *                 Messages entry, cleared the moment the thread is read.
 *   - bellUnread: official announcements only. Shown on the bell; DMs never
 *                 inflate it.
 *
 * One module-level poller feeds every mounted consumer, so having the bell
 * and the hamburger on screen does not double the request rate. A poll (not
 * a socket) is deliberate: delivery is not latency-critical and a poll
 * survives every network and hosting condition.
 */

interface Counts {
  dmUnread: number;
  bellUnread: number;
}

const listeners = new Set<(c: Counts) => void>();
let current: Counts = { dmUnread: 0, bellUnread: 0 };
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
    const data = (await res.json()) as { messages?: CountEnvelope[] };
    const messages = data.messages ?? [];
    const dm = messages.filter((m) => m.kind === "dm" && m.readAt === null).length;
    const bell = messages.filter(
      (m) => (m.kind === "broadcast" || m.kind === "support") && m.readAt === null,
    ).length;
    if (dm !== current.dmUnread || bell !== current.bellUnread) {
      current = { dmUnread: dm, bellUnread: bell };
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
  timer = setInterval(() => void fetchCounts(playerId), 20_000);
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  pollerPlayerId = null;
}

/** Reset counts (identity change / sign-out) and notify listeners. */
export function resetMessageCounts(): void {
  current = { dmUnread: 0, bellUnread: 0 };
  for (const fn of listeners) fn(current);
}

/** Force a refresh right now (e.g. after sending or reading a thread). */
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
