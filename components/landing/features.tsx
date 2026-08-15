import Link from "next/link";
import { ArrowRight, BookOpen, TrendingUp } from "lucide-react";

const FEATURES = [
  {
    index: "01",
    glyph: "♞",
    title: "Play",
    description:
      "Competitive matches with familiar chess controls. Create a game, share the link, and play from any device.",
    href: "/create",
    linkLabel: "Start playing",
  },
  {
    index: "02",
    glyph: null,
    title: "Analyze",
    description:
      "Understand the ideas behind your moves. Every move gets commentary from the ChainMate analysis engine.",
    href: "/watch",
    linkLabel: "Explore analysis",
  },
  {
    index: "03",
    glyph: null,
    title: "Improve",
    description:
      "Turn finished games into lessons. Every match ends with a report: how it opened, where it turned, and how it ended.",
    href: "/games",
    linkLabel: "View reports",
  },
];

function FeatureIcon({ index }: { index: string }) {
  if (index === "01") {
    return <span className="font-serif text-xl text-primary">♞</span>;
  }
  if (index === "02") {
    return <TrendingUp className="h-5 w-5 text-primary" aria-hidden />;
  }
  return <BookOpen className="h-5 w-5 text-primary" aria-hidden />;
}

export function Features() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map(({ index, title, description, href, linkLabel }) => (
            <div
              key={index}
              className="group flex flex-col rounded-lg border border-primary/15 bg-card/40 p-6 transition-colors hover:border-primary/40"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-md border border-primary/25 bg-primary/5">
                  <FeatureIcon index={index} />
                </span>
                <span className="font-mono text-xs text-muted-foreground">{index}</span>
              </div>
              <h3 className="font-display mt-4 text-lg font-semibold tracking-tight">
                {title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
              <Link
                href={href}
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary transition-colors hover:text-accent"
              >
                {linkLabel}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
