"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { BoardVisual } from "@/components/landing/board-visual";
import { useIdentity } from "@/lib/identity-context";
import { cn } from "@/lib/utils";

/**
 * The homepage. The promise on the left, one Play button, the board doing
 * the talking on the right. Signed-in players go to the lobby; visitors
 * start a guest game instantly — no walls between them and a board.
 */
export function Hero() {
  const identity = useIdentity();
  const isAuthed = !identity.isGuest && identity.username && identity.username.trim().length > 0;

  return (
    <section className="relative">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:py-20">
        <div className="animate-fade-in-up max-w-xl">
          <p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            Fair play, enforced
          </p>
          <h1 className="font-display mt-6 text-4xl font-bold leading-[1.06] tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
            Play chess.
            <br />
            <span className="text-primary">Think deeper.</span>
          </h1>
          <div className="mt-9">
            <Link
              href={isAuthed ? "/play" : "/create"}
              className={cn(
                buttonVariants({ size: "lg" }),
                "h-12 rounded-full bg-primary px-10 text-base font-medium text-primary-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/15 active:translate-y-0",
              )}
            >
              Play
            </Link>
          </div>
        </div>
        <div className="animate-fade-in-up [animation-delay:100ms]">
          <BoardVisual />
        </div>
      </div>
    </section>
  );
}
