"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Trophy, User, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/create", label: "Play", className: "" },
  { href: "/join", label: "Join", className: "hidden sm:inline" },
  { href: "/watch", label: "Watch", className: "hidden sm:inline" },
  { href: "/create?mode=ai", label: "Solo", className: "hidden sm:inline" },
];

const MOBILE_LINKS = [
  { href: "/create", label: "Play" },
  { href: "/join", label: "Join" },
  { href: "/watch", label: "Watch" },
  { href: "/create?mode=ai", label: "Solo" },
  { href: "/games", label: "Games" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);

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

          <Link
            href="/create?mode=ai"
            className={cn(
              buttonVariants({ size: "sm" }),
              "hidden bg-primary text-primary-foreground hover:bg-primary/90 md:inline-flex",
            )}
          >
            <Trophy className="h-3.5 w-3.5" aria-hidden />
            Play vs AI
          </Link>

          <Link
            href="/profile"
            aria-label="Profile"
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "text-muted-foreground hover:text-foreground",
            )}
          >
            <User aria-hidden />
          </Link>

          <span
            className="ml-1 hidden items-center gap-1.5 border-l border-border/70 pl-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 xl:flex"
            title="Chess rules are enforced by an intelligent contract on the GenLayer network"
          >
            <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
            Secured by GenLayer
          </span>

          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "sm:hidden")}
          >
            {open ? <X aria-hidden /> : <Menu aria-hidden />}
          </button>
        </nav>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="border-t border-border/60 bg-background/95 px-4 py-2 sm:hidden">
          {MOBILE_LINKS.map(({ href, label }) => {
            const path = href.split("?")[0];
            const active = pathname.startsWith(path) && pathname !== "/";
            return (
              <Link
                key={href}
                href={href}
                onClick={close}
                className={cn(
                  "block rounded-md px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                  active && "text-foreground",
                )}
              >
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </header>
  );
}
