const FUNCTIONS = [
  ["create_game()", "Creator becomes White"],
  ["join_game()", "Second player joins as Black"],
  ["submit_move(from, to)", "Validate & store a move"],
  ["resign_game()", "Give up — opponent wins"],
  ["get_game()", "Read the full game state"],
  ["generate_match_summary()", "LLM analysis, agreed by validators"],
];

export function GenLayerSection() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-20">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Infrastructure
          </p>
          <h2 className="font-display mt-3 text-2xl font-bold tracking-tight text-balance sm:text-3xl">
            Chess rules, enforced by an intelligent contract.
          </h2>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
            ChainMate runs as a Python intelligent contract on the GenLayer
            network (testnet Bradbury). The contract embeds a complete chess
            engine — move legality, turns, check and checkmate are enforced by
            consensus, not by the app. When a game ends, the network&rsquo;s
            validators independently write and cross-check the match analysis
            with their own LLMs.
          </p>
        </div>
        <div className="rounded-lg border border-border/70 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <code className="font-mono text-xs text-foreground/85">
              contracts/chainmate.py
            </code>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              GenVM · Bradbury
            </span>
          </div>
          <div className="divide-y divide-border/50">
            {FUNCTIONS.map(([fn, desc]) => (
              <div key={fn} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <code className="font-mono text-xs text-accent">{fn}</code>
                <span className="text-right text-xs text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
