import Link from "next/link";
import { ArrowRight, Eye, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { BoardVisual } from "@/components/landing/board-visual";
import { HomeSidebar } from "@/components/home/home-sidebar";
import { SocialProof } from "@/components/home/social-proof";
import { cn } from "@/lib/utils";

export function Hero() {
  return (
    <section className="relative">
      <div className="mx-auto grid w-full max-w-6xl items-start gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,540px)_minmax(0,320px)] lg:gap-8 lg:py-16">
        {/* Left: copy */}
        <div className="animate-fade-in-up max-w-xl lg:sticky lg:top-24">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Secured by GenLayer
          </p>
          <h1 className="font-display mt-6 text-4xl font-bold leading-[1.06] tracking-tight text-balance sm:text-5xl">
            Play chess.
            <br />
            <span className="text-primary">Think deeper.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            Competitive chess with intelligent analysis. Every move is validated
            by GenLayer, and every game ends with a clear report on how it was
            won.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/create"
              className={cn(
                buttonVariants({ size: "lg" }),
                "bg-primary text-primary-foreground shadow-lg shadow-primary/10 hover:bg-primary/90",
              )}
            >
              Play chess
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/watch"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
            >
              <Eye className="h-4 w-4" aria-hidden />
              Watch a game
            </Link>
          </div>
          <SocialProof />
        </div>

        {/* Center: board */}
        <div className="animate-fade-in-up [animation-delay:100ms]">
          <BoardVisual />
        </div>

        {/* Right: analysis + recent games */}
        <div className="animate-fade-in-up [animation-delay:150ms]">
          <HomeSidebar />
        </div>
      </div>
    </section>
  );
}
