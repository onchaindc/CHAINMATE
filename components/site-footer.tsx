"use client";

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
      <div className="mx-auto w-full max-w-6xl px-4 py-6 text-center sm:px-6">
        <p className="text-xs text-muted-foreground">
          Play chess. Think deeper.
        </p>
      </div>
    </footer>
  );
}
