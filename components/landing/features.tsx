const FEATURES = [
  {
    index: "01",
    title: "Play",
    description:
      "Competitive matches with familiar chess controls. Create a game, share the link, and play from any device — or challenge the on-device AI.",
  },
  {
    index: "02",
    title: "Analyze",
    description:
      "Understand the ideas behind your moves. Every move gets commentary from the ChainMate analysis engine, with captures, threats and checks called out.",
  },
  {
    index: "03",
    title: "Improve",
    description:
      "Turn finished games into lessons. Every match ends with a report: how it opened, where it turned, and how it ended.",
  },
];

export function Features() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <div className="grid gap-10 md:grid-cols-3 md:gap-8">
          {FEATURES.map(({ index, title, description }) => (
            <div key={index} className="border-l border-border/70 pl-5">
              <p className="font-mono text-xs text-primary">{index}</p>
              <h3 className="font-display mt-2 text-lg font-semibold tracking-tight">
                {title}
              </h3>
              <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
