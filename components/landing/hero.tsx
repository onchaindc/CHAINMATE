"use client";

import Link from "next/link";
import { Bot, Gamepad2, Play } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { BoardVisual } from "@/components/landing/board-visual";
import { useIdentity } from "@/lib/identity-context";
import { cn } from "@/lib/utils";

/**
 * The homepage. One section, one column, centered: the promise, the buttons,
 * and a big board doing the talking. Everything the visitor needs to decide
 * to play fits on the first screen.
 */
export function Hero() {
  const identity = useIdentity();
  const isAuthed = !identity.isGuest && identity.username && identity.username.trim().length > 0;

  return (
    <section className="relative">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 pb-16 pt-12 text-center sm:px-6 lg:pb-24 lg:pt-16">
        <p className="animate-fade-in-up flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
          Fair play, enforced
        </p>

        <h1 className="animate-fade-in-up font-display mt-5 text-5xl font-bold leading-[1.04] tracking-tight text-balance sm:text-6xl lg:text-7xl">
          Play chess.
          <br />
          <span className="text-primary">Think deeper.</span>
        </h1>

        <p className="animate-fade-in-up mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
          Every game ends with a clear report on how it was won — and every
          move is checked as it&rsquo;s played.
        </p>

        <div className="animate-fade-in-up mt-8 flex flex-wrap items-center justify-center gap-3">
          {isAuthed ? (
            <>
              <Link
                href="/play"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "bg-primary text-primary-foreground shadow-lg shadow-primary/10 hover:bg-primary/90",
                )}
              >
                <Play className="h-4 w-4" aria-hidden />
                Play
              </Link>
              <Link
                href="/solo"
                className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
              >
                <Bot aria-hidden />
                Play vs AI
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/auth"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "bg-primary text-primary-foreground shadow-lg shadow-primary/10 hover:bg-primary/90",
                )}
              >
                Sign Up
              </Link>
              <Link
                href="/create"
                className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
              >
                <Gamepad2 aria-hidden />
                Play as Guest
              </Link>
            </>
          )}
        </div>

        {!isAuthed && (
          <p className="animate-fade-in-up mt-3 text-2xs text-muted-foreground">
            Sign up to save your rating, history and achievements across devices.
          </p>
        )}

        {/* The board is the product. Big, centred, uncluttered. */}
        <div className="animate-fade-in-up mt-12 w-full max-w-2xl [animation-delay:120ms] lg:mt-16">
          <BoardVisual />
        </div>

        {/* The three things worth knowing, in one quiet line. */}
        <ul className="animate-fade-in-up mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground [animation-delay:200ms]">
          <li>Move-by-move commentary</li>
          <li aria-hidden className="h-1 w-1 rounded-full bg-border" />
          <li>Post-game match report</li>
          <li aria-hidden className="h-1 w-1 rounded-full bg-border" />
          <li>Play from any device</li>
        </ul>
      </div>
    </section>
  );
}
