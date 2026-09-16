const HIGHLIGHTS = [
  ["Key moments", "The opening, the turning point and the final tactic"],
  ["Move by move", "Every capture, check and threat put in context"],
  ["Fair play", "Rules checked on every move, for both players"],
  ["Match report", "A clear summary of how the game was won"],
];

export function GenLayerSection() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-20">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Game Analysis
          </p>
          <h2 className="font-display mt-3 text-2xl font-bold tracking-tight text-balance sm:text-3xl">
            Every game ends with a report worth reading.
          </h2>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
            ChainMate follows every move and turns the finished game into a
            clear match report — the opening, the turning point and how it was
            won. The rules are enforced for both players the whole way through,
            so the result always stands on its own.
          </p>
        </div>
        <div className="rounded-lg border border-border/70 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <span className="font-display text-sm font-semibold text-foreground/85">
              Game Analysis
            </span>
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              ChainMate
            </span>
          </div>
          <div className="divide-y divide-border/50">
            {HIGHLIGHTS.map(([title, desc]) => (
              <div key={title} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="text-xs font-medium text-accent">{title}</span>
                <span className="text-right text-xs text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
