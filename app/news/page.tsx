"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Newspaper, Radio } from "lucide-react";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingRows } from "@/components/ui/states";
import { cn } from "@/lib/utils";

/**
 * News — live chess news read INSIDE the app.
 *
 * The list is organized: a featured hero, source tabs (All / Chess.com /
 * FIDE), and a two-column grid on desktop so the page never trails off into
 * empty space. Clicking a story opens the reader view in place — the full
 * feed-provided body text with a link out for the complete article. No
 * modal, no external jump unless the player asks for it.
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

type SourceFilter = "all" | "Chess.com" | "FIDE";
const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Chess.com", label: "Chess.com" },
  { id: "FIDE", label: "FIDE" },
];

export default function NewsPage() {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [openItem, setOpenItem] = useState<NewsItem | null>(null);

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

  const filtered = useMemo(() => {
    if (!items) return null;
    return filter === "all" ? items : items.filter((n) => n.source === filter);
  }, [items, filter]);

  const latest = filtered?.[0];
  const rest = filtered?.slice(1) ?? [];

  if (openItem) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
        <Button variant="ghost" size="sm" className="mb-4 -ml-2" onClick={() => setOpenItem(null)}>
          <ArrowLeft aria-hidden />
          Back to news
        </Button>
        <article>
          <p className="text-2xs font-semibold uppercase tracking-wider text-primary">
            {openItem.source ?? openItem.author ?? "Chess news"}
            {openItem.publishedAt ? (
              <span className="ml-2 font-normal text-muted-foreground">
                {dateLabel(openItem.publishedAt)}
              </span>
            ) : null}
          </p>
          <h1 className="font-display mt-2 text-3xl font-bold leading-tight tracking-tight">
            {openItem.title}
          </h1>
          {openItem.imageUrl && (
            <div className="mt-5 overflow-hidden rounded-xl border border-border/60 bg-secondary/30">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={openItem.imageUrl}
                alt=""
                className="max-h-[420px] w-full object-cover"
              />
            </div>
          )}
          {openItem.excerpt && (
            <div className="mt-5 space-y-4">
              {openItem.excerpt
                .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
                .reduce<string[]>((paras, sentence) => {
                  // Group sentences into readable paragraphs of ~3.
                  const last = paras[paras.length - 1];
                  if (last && last.split(" ").length < 60) {
                    paras[paras.length - 1] = `${last} ${sentence}`;
                  } else {
                    paras.push(sentence);
                  }
                  return paras;
                }, [])
                .map((p, i) => (
                  <p key={i} className="text-[0.95rem] leading-relaxed text-foreground/90">
                    {p}
                  </p>
                ))}
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
            <a
              href={openItem.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="sm">
                <ExternalLink aria-hidden />
                Read the full article
                <span className="sr-only"> (opens the publisher&apos;s site)</span>
              </Button>
            </a>
            <p className="text-2xs leading-snug text-muted-foreground">
              Story by {openItem.source ?? openItem.author ?? "the publisher"} — summarized
              here, complete on their site.
            </p>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-12">
      <BackLink href="/" className="mb-4">
        Back to home
      </BackLink>
      <PageHeader
        eyebrow="Chess world"
        title="News"
        description="The latest from the chess world, newest first. Stories open right here in the app."
      />

      {/* Source tabs — the section is organized, not one undifferentiated pile. */}
      {items !== null && items.length > 0 && (
        <div className="mt-6 flex gap-1.5">
          {SOURCE_TABS.map((tab) => {
            const count =
              tab.id === "all"
                ? (items?.length ?? 0)
                : (items ?? []).filter((n) => n.source === tab.id).length;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors",
                  filter === tab.id
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                <span className="ml-1.5 font-mono text-2xs opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {filtered === null && (
        <Panel className="mt-6">
          <LoadingRows rows={6} />
        </Panel>
      )}

      {filtered !== null && filtered.length === 0 && (
        <Panel className="mt-6">
          <EmptyState
            icon={Newspaper}
            title={failed ? "News is unavailable right now" : filter === "all" ? "No stories this month" : `No ${filter} stories this month`}
            description="The news feed could not be reached, or there is nothing new. Check back soon."
            action={{ href: "/", label: "Back home" }}
          />
        </Panel>
      )}

      {filtered !== null && filtered.length > 0 && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-6">
          {/* Featured story, large with art. */}
          {latest && (
            <button
              type="button"
              onClick={() => setOpenItem(latest)}
              className="group block overflow-hidden rounded-xl border border-border/70 bg-card/50 text-left shadow-elevation-1 transition-shadow hover:shadow-elevation-2"
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
              <div className="p-4 sm:p-5">
                <p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-primary">
                  <Radio className="h-3 w-3" aria-hidden />
                  Latest
                  <span className="font-normal text-muted-foreground">
                    {dateLabel(latest.publishedAt)}
                  </span>
                </p>
                <h2 className="mt-1.5 text-lg font-bold leading-snug tracking-tight group-hover:underline">
                  {latest.title}
                </h2>
                {latest.excerpt && (
                  <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                    {latest.excerpt}
                  </p>
                )}
                <p className="mt-2.5 text-2xs text-muted-foreground">
                  {latest.source ?? latest.author ?? "Chess.com"} · tap to read in the app
                </p>
              </div>
            </button>
          )}

          {/* The rest — a tight two-column grid on desktop so the page stays
              dense instead of trailing into empty space. Every card shares one
              skeleton — fixed-height image slot (a quiet placeholder when a
              story has no art) with the same line clamps — so rows stay level
              instead of ragging where some stories have images and some do
              not. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {rest.map((item, i) => (
              <button
                key={`${item.url}-${i}`}
                type="button"
                onClick={() => setOpenItem(item)}
                className="group flex h-full flex-col rounded-lg border border-border/60 bg-card/40 p-3 text-left transition-colors hover:bg-card/70"
              >
                <div className="mb-2.5 h-28 w-full overflow-hidden rounded-md bg-secondary/40">
                  {item.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={item.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div
                      className="flex h-full w-full items-center justify-center text-muted-foreground/40"
                      aria-hidden
                    >
                      <Newspaper className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <p className="text-2xs text-muted-foreground">
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
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
