"use client";

import Link from "next/link";
import { Bot, Gamepad2, Play } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useIdentity } from "@/lib/identity-context";
import { cn } from "@/lib/utils";

export function FinalCta() {
  const identity = useIdentity();
  const isAuthed = !identity.isGuest && identity.username && identity.username.trim().length > 0;

  return (
    <section className="border-t border-border/50">
      <div className="mx-auto w-full max-w-3xl px-4 py-16 text-center sm:px-6 lg:py-20">
        <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
          Ready to make your first move?
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          {isAuthed
            ? "Ready for your next match?"
            : "Create an account to track your rating, history and achievements — or jump straight in as a guest."}
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {isAuthed ? (
            <>
              <Link href="/play" className={cn(buttonVariants({ size: "lg" }))}>
                <Play aria-hidden /> Play
              </Link>
              <Link href="/create?mode=ai" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
                <Bot aria-hidden /> Play vs AI
              </Link>
            </>
          ) : (
            <>
              <Link href="/auth" className={cn(buttonVariants({ size: "lg" }))}>
                Sign Up
              </Link>
              <Link href="/create" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
                <Gamepad2 aria-hidden /> Play as Guest
              </Link>
              <Link href="/create?mode=ai" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
                <Bot aria-hidden /> Play vs AI
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
