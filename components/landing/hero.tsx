import Link from "next/link";
import { ArrowRight, Gamepad2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { BoardVisual } from "@/components/landing/board-visual";
import { cn } from "@/lib/utils";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:py-24">
        <div className="animate-fade-in-up">
          <Badge variant="gold" className="mb-5 gap-1.5">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Powered by GenLayer intelligent contracts
          </Badge>
          <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Chess that{" "}
            <span className="bg-gradient-to-r from-emerald-400 via-emerald-300 to-accent bg-clip-text text-transparent">
              thinks
            </span>
            . Played on-chain.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            ChainMate is a two-player chess dApp where every move is validated
            by a GenLayer intelligent contract, every move gets instant AI
            commentary, and every finished game receives a post-game analysis —
            written on-chain.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/create"
              className={cn(buttonVariants({ size: "lg" }), "shadow-lg shadow-primary/25")}
            >
              <Gamepad2 aria-hidden />
              Create a game
            </Link>
            <Link
              href="/join"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
            >
              Join a game
              <ArrowRight aria-hidden />
            </Link>
          </div>
          <dl className="mt-10 grid max-w-md grid-cols-3 gap-6 border-t border-border/70 pt-6">
            {[
              ["100%", "moves validated on-chain"],
              ["0", "sign-ups required to play"],
              ["2", "players, one smart contract"],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="font-display text-2xl font-bold text-foreground">{value}</dt>
                <dd className="mt-1 text-xs leading-snug text-muted-foreground">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="animate-fade-in-up [animation-delay:150ms]">
          <BoardVisual />
        </div>
      </div>
    </section>
  );
}
