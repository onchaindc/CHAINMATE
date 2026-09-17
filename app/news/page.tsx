"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Newspaper } from "lucide-react";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, LoadingRows } from "@/components/ui/states";
import { cn } from "@/lib/utils";

/**
 * News — live chess news with images, newest first, one month back.
 *
 * The list is the page: each row is a real article with its publisher image,
 * an excerpt, and a link out to the full story. "Latest" is the first item,
 * rendered larger; the rest follow as a clean scrollable list.
 */

interface NewsItem {
  title: string;
  excerpt: string | null;
  url: string;
  imageUrl: string | null;
  publishedAt: number;
  author: string | null;
  tags: string[];
  source?: string;
}

function dateLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  const rel = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${rel}`;
}

export default function NewsPage() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/news");
        const data = (await res.json()) as { items?: NewsItem[] };
        if (!cancelled) setItems(data.items ?? []);
      } catch {
        if (!cancelled) {
          setItems([]);
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const latest = items?.[0];
  const rest = items?.slice(1) ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <BackLink href="/" className="mb-4">
        Back to home
      </BackLink>
      <PageHeader
        eyebrow="Chess world"
        title="News"
        description="The latest from the chess world, newest first. Tap any story for the full article."
      />

      {items === null && (
        <Panel className="mt-8">
          <LoadingRows rows={6} />
        </Panel>
      )}

      {items !== null && items.length === 0 && (
        <Panel className="mt-8">
          <EmptyState
            icon={Newspaper}
            title={failed ? "News is unavailable right now" : "No stories this month"}
            description="The news feed could not be reached, or there is nothing new. Check back soon."
            action={{ href: "/", label: "Back home" }}
          />
        </Panel>
      )}

      {items !== null && items.length > 0 && (
        <div className="mt-8 grid gap-4">
          {latest && (
            <a
              href={latest.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group block overflow-hidden rounded-xl border border-border/70 bg-card/50 shadow-elevation-1 transition-shadow hover:shadow-elevation-2"
            >
              {latest.imageUrl && (
                <div className="aspect-[2/1] w-full overflow-hidden bg-secondary/40">
                  {/* Publisher CDN images: plain img with lazy loading — no
                      domain allowlist needed, and lazy keeps the page light. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={latest.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                  />
                </div>
              )}
              <div className="p-4">
                <p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-primary">
                  Latest
                  <span className="font-normal text-muted-foreground">{dateLabel(latest.publishedAt)}</span>
                </p>
                <h2 className="mt-1.5 text-lg font-bold leading-snug tracking-tight group-hover:underline">
                  {latest.title}
                </h2>
                {latest.excerpt && (
                  <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                    {latest.excerpt}
                  </p>
                )}
                <p className="mt-2 flex items-center gap-1 text-2xs text-muted-foreground">
                  <ExternalLink className="h-3 w-3" aria-hidden />
                  {latest.source ?? latest.author ?? "Chess.com"}
                </p>
              </div>
            </a>
          )}

          {rest.map((item, i) => (
            <a
              key={`${item.url}-${i}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-3 rounded-lg border border-border/60 bg-card/40 p-3 transition-colors hover:bg-card/70"
            >
              {item.imageUrl && (
                <div className="h-20 w-28 shrink-0 overflow-hidden rounded-md bg-secondary/40 sm:h-24 sm:w-36">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className={cn("text-2xs text-muted-foreground")}>
                  {item.source ? `${item.source} · ` : ""}
                  {dateLabel(item.publishedAt)}
                </p>
                <h3 className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug group-hover:underline">
                  {item.title}
                </h3>
                {item.excerpt && (
                  <p className="mt-1 line-clamp-2 text-2xs leading-snug text-muted-foreground">
                    {item.excerpt}
                  </p>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
