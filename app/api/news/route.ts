import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 900;

/**
 * /api/news — live chess news with images for the News section.
 *
 * Sources: Chess.com's public news RSS and FIDE's official feed. Both are
 * keyless. (Chess.com's JSON API is Cloudflare-gated and 403s from datacenter
 * IPs — the RSS endpoints do not.) The server fetches both, merges, filters
 * to the last month, sorts newest first, and caches for 15 minutes so
 * clients hit ChainMate, never the sources. Images come from the feeds
 * themselves (FIDE embeds article art in content:encoded; Chess.com's RSS
 * carries none, so those rows render with the app mark).
 */

interface NewsItem {
  title: string;
  excerpt: string | null;
  url: string;
  imageUrl: string | null;
  publishedAt: number;
  author: string | null;
  tags: string[];
  source: string;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Readers want the whole story in the app, so feed-provided full text is kept
 * whole: FIDE's content:encoded carries complete articles (8k+ characters)
 * and truncating it to a teaser made every in-app read cut off mid-sentence.
 * The cap is a payload guard against pathological feeds, not an editorial
 * cut: 20k characters is roughly ten normal-length articles.
 */
const MAX_BODY_CHARS = 20_000;
const UA = "ChainMate/1.0 (chess app news reader)";

/** Decode XML entities and strip tags for plain-text excerpts. */
function clean(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/** First <img src="…"> inside a chunk of (possibly CDATA-wrapped) HTML. */
function firstImage(html: string): string | null {
  const unwrapped = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const m = /<img[^>]*\ssrc=["']?(https?:\/\/[^"'\s>]+)/i.exec(unwrapped);
  return m ? m[1] : null;
}

/** Collect <item>…</item> blocks from an RSS document. */
function itemsOf(xml: string): string[] {
  return xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
}

function tagText(item: string, tag: string): string | null {
  // Both plain and namespaced variants (content:encoded, dc:creator).
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(item);
  return m ? m[1] : null;
}

function parseDate(raw: string | null): number {
  if (!raw) return 0;
  const t = Date.parse(clean(raw));
  return Number.isNaN(t) ? 0 : t;
}

async function chessComNews(): Promise<NewsItem[]> {
  try {
    const res = await fetch("https://www.chess.com/rss/news", {
      headers: { "User-Agent": UA, Accept: "application/rss+xml" },
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return itemsOf(xml)
      .map((item): NewsItem => {
        const title = clean(tagText(item, "title") ?? "");
        const link = clean(tagText(item, "link") ?? "");
        // Prefer full content when the feed offers it (some feeds do); the
        // description is the ~250-char summary fallback.
        const bodySource =
          tagText(item, "content:encoded") ?? tagText(item, "description") ?? "";
        const excerpt = clean(bodySource).slice(0, MAX_BODY_CHARS);
        return {
          title,
          excerpt: excerpt || null,
          url: link,
          imageUrl: firstImage(bodySource),
          publishedAt: parseDate(tagText(item, "pubDate")),
          author: "Chess.com",
          tags: [],
          source: "Chess.com",
        };
      })
      .filter((n) => n.title && n.url.startsWith("http"));
  } catch {
    return [];
  }
}

async function fideNews(): Promise<NewsItem[]> {
  try {
    const res = await fetch("https://www.fide.com/feed/", {
      headers: { "User-Agent": UA, Accept: "application/rss+xml" },
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return itemsOf(xml)
      .map((item): NewsItem => {
        const title = clean(tagText(item, "title") ?? "");
        const link = clean(tagText(item, "link") ?? "");
        const contentEncoded =
          tagText(item, "content:encoded") ?? tagText(item, "description") ?? "";
        // Full article text, not a teaser. FIDE embeds complete stories here;
        // slicing it at 400 chars was what made in-app reads feel cut off.
        const excerpt = clean(contentEncoded).slice(0, MAX_BODY_CHARS);
        return {
          title,
          excerpt: excerpt || null,
          url: link,
          imageUrl: firstImage(contentEncoded),
          publishedAt: parseDate(tagText(item, "pubDate")),
          author: clean(tagText(item, "dc:creator") ?? "") || "FIDE",
          tags: [],
          source: "FIDE",
        };
      })
      .filter((n) => n.title && n.url.startsWith("http"));
  } catch {
    return [];
  }
}

export async function GET() {
  const [chessCom, fide] = await Promise.all([chessComNews(), fideNews()]);
  const cutoff = Date.now() - MONTH_MS;
  const items = [...chessCom, ...fide]
    .filter((n) => n.publishedAt >= cutoff)
    // Interleave by recency: one merged timeline, newest first.
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 40);
  return NextResponse.json({ items, sources: ["Chess.com", "FIDE"] });
}
