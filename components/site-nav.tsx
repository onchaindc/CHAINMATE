"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { PlayerMenu } from "@/components/auth/player-menu";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/create", label: "Play", className: "" },
  { href: "/join", label: "Join", className: "hidden sm:inline" },
  { href: "/create?mode=ai", label: "Solo", className: "hidden sm:inline" },
  { href: "/watch", label: "Watch", className: "hidden md:inline" },
  { href: "/games", label: "Games", className: "hidden md:inline" },
  { href: "/leaderboard", label: "Leaderboard", className: "hidden lg:inline" },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="group flex shrink-0 items-center" aria-label="ChainMate home">
          <img
            src="/logo.svg"
            alt="ChainMate"
            className="h-8 w-auto opacity-90 transition-opacity group-hover:opacity-100"
          />
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          {LINKS.map(({ href, label, className }) => {
            const path = href.split("?")[0];
            const active = pathname.startsWith(path) && pathname !== "/";
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "relative px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  active && "text-foreground",
                  className,
                )}
              >
                {label}
                {active && (
                  <span className="absolute inset-x-2.5 -bottom-px h-px bg-primary" aria-hidden />
                )}
              </Link>
            );
          })}
          <PlayerMenu />
          <Link
            href="/create"
            aria-label="Create game"
            className={cn(buttonVariants({ size: "icon" }), "sm:hidden")}
          >
            <Plus aria-hidden />
          </Link>
          <span
            className="ml-1 hidden items-center gap-1.5 border-l border-border/70 pl-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 xl:flex"
            title="Chess rules are enforced by an intelligent contract on the GenLayer network"
          >
            <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
            Secured by GenLayer
          </span>
        </nav>
      </div>
    </header>
  );
}
