import { Link2, MousePointerClick, Trophy } from "lucide-react";

const STEPS = [
  {
    icon: MousePointerClick,
    step: "01",
    title: "Create a game",
    description:
      "Deploy a fresh ChainMate contract (or spin up a local game). You automatically play White.",
  },
  {
    icon: Link2,
    step: "02",
    title: "Share the link",
    description:
      "Send the game link to a friend. They join as Black with one click — no account needed.",
  },
  {
    icon: Trophy,
    step: "03",
    title: "Play & review",
    description:
      "Move by move, the contract validates and records the game. Enjoy AI commentary and a post-game analysis.",
  },
];

export function HowItWorks() {
  return (
    <section className="border-t border-border/50 bg-card/30">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Three steps
          </p>
          <h2 className="font-display mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            From opening move to final analysis
          </h2>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, step, title, description }, i) => (
            <div
              key={step}
              className="relative rounded-xl border border-border/70 bg-card p-6 transition-colors hover:border-primary/40"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="font-display text-3xl font-bold text-border">
                  {step}
                </span>
              </div>
              <h3 className="font-display mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
              {i < STEPS.length - 1 && (
                <div
                  aria-hidden
                  className="absolute -right-3 top-1/2 hidden h-px w-6 -translate-y-1/2 bg-border md:block"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
