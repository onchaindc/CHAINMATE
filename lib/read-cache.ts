"use client";

/**
 * Cached reads — the reason revisiting a section no longer blanks.
 *
 * Every section page used to hold its data in `useState(null)` and fetch in a
 * mount effect, so navigating away unmounted the page and THREW the data
 * away: every tab switch re-showed a skeleton and re-waited for the network
 * (the "content loads late" report). This module keeps a small in-memory
 * cache keyed by endpoint, and `useCachedRead` renders it SYNCHRONOUSLY on
 * mount while it revalidates in the background — the section appears the
 * instant you navigate to it, then quietly refreshes. Stale-while-revalidate,
 * ~40 lines, no dependency.
 *
 * Rules:
 *  - The cache is per browser session (module scope) and intentionally NOT
 *    persisted: a reload is a fresh context, and nothing here must outlive
 *    the tab it was fetched in.
 *  - `refresh` forces a re-fetch (poll loops and post-mutation refreshes use
 *    it). Concurrent calls for one key share a single in-flight promise, so
 *    the bell + a page polling the same endpoint do not multiply requests.
 *  - Data is always what the page renders; `loading` is true only when there
 *    is genuinely nothing to show yet (first ever visit), so skeletons appear
 *    once per session instead of on every navigation.
 *  - Keyed reads must be pure GETs; mutations keep their own paths and call
 *    `refresh` after they succeed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Fetcher<T> = () => Promise<T>;

interface CacheEntry {
  /** The last successfully fetched value (JSON-structured-cloneable). */
  value: unknown;
  /** When the value was fetched; drives nothing yet but keeps debugging sane. */
  fetchedAt: number;
  /** Shared in-flight fetch so concurrent readers await ONE network call. */
  inflight?: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();

/** True when the entry has a value a page can render immediately. */
export function peekCached<T>(key: string): T | null {
  const entry = cache.get(key);
  return entry ? (entry.value as T) : null;
}

/** Drop one key (or everything) — used by sign-out and identity switches. */
export function invalidateReads(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/** Force a re-fetch of one key right now (returns the fresh value). */
export async function refreshRead<T>(key: string, fetcher: Fetcher<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing?.inflight) return existing.inflight as Promise<T>;
  const run = (async () => {
    const value = await fetcher();
    cache.set(key, { value, fetchedAt: Date.now() });
    return value;
  })();
  if (existing) existing.inflight = run;
  else cache.set(key, { value: null, fetchedAt: 0, inflight: run });
  try {
    return await run;
  } finally {
    const entry = cache.get(key);
    if (entry) entry.inflight = undefined;
  }
}

/**
 * The hook: render the cached value immediately, revalidate in the
 * background, and keep polling while mounted when `pollMs` is given.
 * `loading` is true ONLY while nothing has ever been fetched for the key —
 * revisits never show a skeleton.
 */
export function useCachedRead<T>(
  key: string,
  fetcher: Fetcher<T>,
  opts: { pollMs?: number; enabled?: boolean } = {},
): { data: T | null; loading: boolean; error: string | null; refresh: () => Promise<void> } {
  const enabled = opts.enabled !== false;
  const [data, setData] = useState<T | null>(() =>
    enabled ? peekCached<T>(key) : null,
  );
  const [loading, setLoading] = useState<boolean>(enabled && peekCached(key) === null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const value = await refreshRead(key, () => fetcherRef.current());
      setData(value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    const cached = peekCached<T>(key);
    if (cached !== null) setData(cached);
    setLoading(peekCached(key) === null);
    void refresh();
    if (!opts.pollMs) return;
    const timer = setInterval(() => void refresh(), opts.pollMs);
    return () => clearInterval(timer);
  }, [key, enabled, refresh, opts.pollMs]);

  return { data, loading, error, refresh };
}
