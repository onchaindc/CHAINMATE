import { FileCode2, Globe, ShieldCheck, Cpu } from "lucide-react";

const FUNCTIONS = [
  ["create_game()", "Initialise the game — the creator becomes White"],
  ["join_game()", "Second player joins as Black, the game starts"],
  ["submit_move(from, to)", "Validate & store a move with full chess rules"],
  ["resign_game()", "Give up — the opponent wins"],
  ["get_game()", "Read the full state: board, moves, commentary"],
  ["generate_match_summary()", "LLM post-game analysis, agreed by validators"],
];

export function GenLayerSection() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Under the hood
          </p>
          <h2 className="font-display mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            A smart contract that can reason
          </h2>
          <p className="mt-4 leading-relaxed text-muted-foreground">
            ChainMate runs as a Python intelligent contract on the GenLayer
            network (testnet Bradbury). The contract embeds a complete chess
            engine, so legality is enforced by consensus — not by the app. When
            a game ends, <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">generate_match_summary()</code>{" "}
            asks the network&rsquo;s validators to independently write and
            cross-check the match analysis using their own LLMs.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              { icon: ShieldCheck, text: "Chess rules enforced on-chain — illegal moves are rejected by the contract" },
              { icon: Globe, text: "Python smart contract compatible with GenLayer Bradbury & the GenVM" },
              { icon: Cpu, text: "Non-deterministic LLM blocks with validator cross-checks (Optimistic Democracy)" },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-foreground/85">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-5 shadow-xl shadow-black/30">
          <div className="flex items-center justify-between border-b border-border/70 pb-3">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <FileCode2 className="h-4 w-4 text-emerald-400" aria-hidden />
              contracts/chainmate.py
            </span>
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
              GenVM · Bradbury
            </span>
          </div>
          <div className="divide-y divide-border/60">
            {FUNCTIONS.map(([fn, desc]) => (
              <div key={fn} className="flex items-center justify-between gap-4 py-3">
                <code className="font-mono text-sm text-emerald-300">{fn}</code>
                <span className="text-right text-xs text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
