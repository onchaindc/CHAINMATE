"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Plus, X } from "lucide-react";
import { PlayerMenu } from "@/components/auth/player-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * `hideBelow` is the breakpoint at which a link leaves the top bar — every link
 * is still reachable below that width, from the menu. The old nav used
 * `hidden md:inline` and similar with no fallback, so a phone could not get to
 * Watch, Games or Leaderboard at all: the links were simply gone.
 */
const LINKS: { href: string; label: string; hideBelow?: "sm" | "md" | "lg" }[] = [
  { href: "/create", label: "Play" },
  { href: "/join", label: "Join", hideBelow: "sm" },
  { href: "/create?mode=ai", label: "Solo", hideBelow: "sm" },
  { href: "/watch", label: "Watch", hideBelow: "md" },
  { href: "/games", label: "Games", hideBelow: "md" },
  { href: "/leaderboard", label: "Leaderboard", hideBelow: "lg" },
];

const HIDE_CLASS = {
  sm: "hidden sm:inline-flex",
  md: "hidden md:inline-flex",
  lg: "hidden lg:inline-flex",
} as const;

/** True when `href` is the page currently being viewed. */
function isActive(pathname: string, href: string): boolean {
  const path = href.split("?")[0];
  return pathname.startsWith(path) && pathname !== "/";
}

export function SiteNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  /* A route change means the tap landed; the sheet has done its job. Without
     this it stays open over the page it just navigated to. */
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  /* Escape closes it, and the page behind must not scroll while it is open. */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="group flex shrink-0 items-center"
          aria-label="ChainMate home"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG
              logo has no intrinsic raster size for next/image to optimise. */}
          <img
            src="/logo.svg"
            alt="ChainMate"
            className="h-8 w-auto opacity-90 transition-opacity group-hover:opacity-100"
          />
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          {LINKS.map(({ href, label, hideBelow }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  active && "text-foreground",
                  hideBelow && HIDE_CLASS[hideBelow],
                )}
              >
                {label}
                {active && (
                  <span
                    className="absolute inset-x-2.5 -bottom-px h-px bg-primary"
                    aria-hidden
                  />
                )}
              </Link>
            );
          })}

          <ThemeToggle className="hidden sm:inline-flex" />
          <PlayerMenu />

          <Link
            href="/create"
            aria-label="Create game"
            className={cn(buttonVariants({ size: "icon" }), "sm:hidden")}
          >
            <Plus aria-hidden />
          </Link>

          {/* The overflow menu. Shown up to `lg`, because Leaderboard is still
              hidden from the bar below that. */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="site-nav-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "lg:hidden",
            )}
          >
            {menuOpen ? <X aria-hidden /> : <Menu aria-hidden />}
          </button>

          <span
            className="ml-1 hidden items-center gap-1.5 border-l border-border/70 pl-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 xl:flex"
            title="Chess rules are enforced by an intelligent contract on the GenLayer network"
          >
            <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
            Secured by GenLayer
          </span>
        </nav>
      </div>

      {menuOpen && (
        <>
          {/* Click-away. Below the sheet, above the page. */}
          <div
            className="fixed inset-0 top-14 z-30 bg-background/60 backdrop-blur-sm lg:hidden"
            onClick={() => setMenuOpen(false)}
            aria-hidden
          />
          <div
            id="site-nav-menu"
            className="animate-fade-in-up absolute inset-x-0 top-14 z-40 border-b border-border/70 bg-background/95 backdrop-blur-md lg:hidden"
          >
            <ul className="mx-auto grid w-full max-w-6xl gap-0.5 px-2 py-3 sm:px-4">
              {LINKS.map(({ href, label }) => {
                const active = isActive(pathname, href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center justify-between rounded-md px-3 py-2.5 text-sm transition-colors",
                        active
                          ? "bg-secondary/60 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
                      )}
                    >
                      {label}
                      {active && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-primary"
                          aria-hidden
                        />
                      )}
                    </Link>
                  </li>
                );
              })}
              {/* The theme toggle lives in the bar from `sm` up, so on a phone
                  this row is the only way to reach it. */}
              <li className="mt-1 flex items-center justify-between border-t border-border/60 px-3 pt-3 sm:hidden">
                <span className="text-sm text-muted-foreground">Theme</span>
                <ThemeToggle />
              </li>
            </ul>
          </div>
        </>
      )}
    </header>
  );
}
