import Link from "next/link";
import { Gamepad2, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FinalCta() {
  return (
    <section className="border-t border-border/50">
      <div className="mx-auto w-full max-w-4xl px-4 py-16 text-center sm:px-6 lg:py-24">
        <h2 className="font-display text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          Ready to make your first move?
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Start a game right now — the app runs in local mode with zero setup.
          Connect GenLayer keys to play every move on-chain.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
            <Users aria-hidden />
            Join a game
          </Link>
        </div>
      </div>
    </section>
  );
}
