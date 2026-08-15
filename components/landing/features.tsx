import {
  FileText,
  History,
  Radio,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const FEATURES = [
  {
    icon: ShieldCheck,
    title: "On-chain move validation",
    description:
      "A GenLayer intelligent contract enforces the rules of chess — legality, turns, check and checkmate. No referee, no cheating.",
  },
  {
    icon: Radio,
    title: "Real-time play",
    description:
      "Live board updates for both players as moves finalise on the network — with a zero-setup local mode for instant two-player games.",
  },
  {
    icon: Sparkles,
    title: "AI move commentary",
    description:
      "Every move gets instant commentary: captures, threats, center control and checks — written by an LLM when configured.",
  },
  {
    icon: FileText,
    title: "Post-game analysis",
    description:
      "When the game ends, ChainMate writes a 3–5 sentence match summary. On GenLayer, the contract itself asks the validators' LLMs.",
  },
  {
    icon: History,
    title: "Full move history",
    description:
      "Every half-move is stored with SAN notation and squares, replayable move by move — on-chain, permanently.",
  },
  {
    icon: Zap,
    title: "Resignation & status",
    description:
      "Resign anytime. The board tracks turn, check, checkmate, stalemate and winner with clear status indicators.",
  },
];

export function Features() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">
            Everything a chess dApp needs
          </p>
          <h2 className="font-display mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            Play chess. Get coached by the chain.
          </h2>
          <p className="mt-4 text-muted-foreground">
            ChainMate combines a real chess experience with GenLayer&rsquo;s
            intelligent contracts and LLM-powered analysis.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <Card
              key={title}
              className="group border-border/70 bg-card/60 transition-all hover:border-primary/40 hover:bg-card"
            >
              <CardContent className="p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="font-display mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
