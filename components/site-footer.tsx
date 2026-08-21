"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteFooter() {
  const pathname = usePathname();

  /* The game screen is an app, not a document: it sizes itself to exactly one
     viewport so a live game never scrolls, and a site footer hanging below the
     fold would put a scrollbar back on the page it was removed from. Every
     other route keeps it. */
  if (pathname?.startsWith("/game/")) return null;

  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <img src="/logo-mark.svg" alt="" className="h-6 w-6" />
          <span>
            ChainMate — chess, refereed by an intelligent contract on GenLayer.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-5 text-sm text-muted-foreground">
          <Link href="/create" className="transition-colors hover:text-foreground">
            Play
          </Link>
          <Link href="/join" className="transition-colors hover:text-foreground">
            Join
          </Link>
          <Link href="/watch" className="transition-colors hover:text-foreground">
            Watch
          </Link>
          <Link href="/games" className="transition-colors hover:text-foreground">
            Games
          </Link>
          <Link href="/leaderboard" className="transition-colors hover:text-foreground">
            Leaderboard
          </Link>
          <Link href="/profile" className="transition-colors hover:text-foreground">
            Profile
          </Link>
          <a
            href="https://docs.genlayer.com"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            GenLayer docs
          </a>
          <a
            href="https://github.com/onchaindc/CHAINMATE"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs transition-colors hover:text-foreground"
          >
            onchaindc/CHAINMATE
          </a>
        </div>
      </div>
    </footer>
  );
}
