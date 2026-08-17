"use client";

import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";
import { useIdentity } from "@/lib/identity-context";

/**
 * Subtle, dismissible-free banner shown to guests on record pages
 * (Games / Profile). Explains that guest games are casual (nothing is
 * saved) and offers the sign-up path to a real rated profile — never an
 * annoying modal, never on the board.
 */
export function GuestBanner() {
  const identity = useIdentity();
  if (!identity.isGuest || identity.status === "loading") return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3">
      <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/80">
        Playing as <span className="font-mono text-primary">{identity.username}</span> — guest
        games are casual and never change a rating. Create an account for a
        permanent record that starts at 1200 ELO.
      </p>
      <Link
        href="/auth?upgrade=1"
        className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline-offset-2 hover:underline"
      >
        Create account <ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  );
}
