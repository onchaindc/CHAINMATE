"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Plus, X } from "lucide-react";
import { PlayerMenu } from "@/components/auth/player-menu";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { buttonVariants } from "@/components/ui/button";
import { useIdentity } from "@/lib/identity-context";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { cn } from "@/lib/utils";

/**
 * `hideBelow` is the breakpoint at which a link leaves the top bar — every link
 * is still reachable below that width, from the menu. The old nav used
 * `hidden md:inline` and similar with no fallback, so a phone could not get to
 * Watch, Games or Leaderboard at all: the links were simply gone.
 */
const LINKS: {
  href: string;
  /**
   * Where the link goes once there is an account. Play leads to the lobby —
   * resume, matchmaking, challenges and setup are all one page in — while a
   * guest, who has none of that, goes straight to the setup screen.
   */
  authedHref?: string;
  label: string;
  hideBelow?: "sm" | "md" | "lg";
}[] = [
  { href: "/create", authedHref: "/play", label: "Play" },
  { href: "/tournaments", label: "Tournaments", hideBelow: "sm" },
  { href: "/join", label: "Join", hideBelow: "sm" },
  { href: "/solo", label: "AI", hideBelow: "sm" },
  { href: "/watch", label: "Watch", hideBelow: "md" },
  { href: "/games", label: "Games", hideBelow: "md" },
  { href: "/leaderboard", label: "Leaderboard", hideBelow: "lg" },
  { href: "/messages", label: "Messages", hideBelow: "lg" },
  { href: "/news", label: "News", hideBelow: "lg" },
];

const HIDE_CLASS = {
  sm: "hidden sm:inline-flex",
  md: "hidden md:inline-flex",
  lg: "hidden lg:inline-flex",
} as const;

/**
 * True when `href` is the page currently being viewed.
 *
 * Matched on whole path segments, not as a bare string prefix: `/players/magnus`
 * starts with `/play`, so a prefix test lights up the lobby link while you are
 * reading somebody's profile.
 */
function isActive(pathname: string, href: string): boolean {
  const path = href.split("?")[0];
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function SiteNav() {
  const pathname = usePathname();
  const identity = useIdentity();
  const [menuOpen, setMenuOpen] = useState(false);
  const { dmUnread } = useMessageCounts();

  /* The homepage is a welcome, not a hub: its tabs stay out of the header
     until the player has moved on from it (Play, sign-in, any other page).
     Only the landing route hides them — everywhere else they render as usual. */
  const onLanding = pathname === "/";

  const isAuthed =
    !identity.isGuest &&
    Boolean(identity.username && identity.username.trim().length > 0);

  /* Resolved once per identity change, and used by both the bar and the sheet so
     the two can never disagree about where Play goes. */
  const links = useMemo(
    () =>
      LINKS.map((link) => ({
        ...link,
        href: isAuthed && link.authedHref ? link.authedHref : link.href,
      })),
    [isAuthed],
  );

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
        {/* Home is where the player's session lives: a signed-in account lands
            on the play dashboard, everyone else on the welcome page. */}
        <Link
          href={isAuthed ? "/play" : "/"}
          className="group flex shrink-0 items-center"
          aria-label="ChainMate home"
        >
          {/* The mark is a plain high-DPI PNG (a 96px bitmap wrapped in SVG
              rendered jagged at 32px on phones), and the wordmark is real text
              beside it at every size: the name is part of the app's face and
              belongs on a phone just as it shows on desktop. */}
          <img
            src="/logo-mark-192.png"
            alt="ChainMate"
            className="h-8 w-8 opacity-90 transition-opacity group-hover:opacity-100"
          />
          <span
            aria-hidden
            className="pl-2 text-base font-bold tracking-[0.16em] sm:pl-2.5 sm:text-lg sm:tracking-[0.18em]"
          >
            <span className="text-[#EDE7DA]">CHAIN</span>
            <span className="text-[#C9A86A]">MATE</span>
          </span>
        </Link>

        <nav className="flex min-w-0 items-center gap-1 sm:gap-2">
          {links.map(({ href, label, hideBelow }) => {
            if (onLanding) return null;
            const active = isActive(pathname, href);
            return (
              <Link
                key={label}
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

          {/* The bell is product chrome for players mid-session, not part of
              the welcome: on the landing page the header stays exactly as it
              was before it existed. */}
          {!onLanding && <NotificationBell />}

          <PlayerMenu />

          <Link
            href="/create"
            aria-label="Create game"
            className={cn(buttonVariants({ size: "icon" }), "sm:hidden")}
          >
            <Plus aria-hidden />
          </Link>

          {/* The overflow menu. Shown up to `lg`, because Leaderboard is still
              hidden from the bar below that. Nothing to open on the landing
              page — its tabs are hidden too — so the button rests there. */}
          {!onLanding && (
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-controls="site-nav-menu"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon" }),
                "shrink-0 text-foreground/85 lg:hidden",
              )}
            >
              {menuOpen ? <X aria-hidden /> : <Menu aria-hidden strokeWidth={2.5} />}
            </button>
          )}
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
              {links.map(({ href, label }) => {
                const active = isActive(pathname, href);
                const dmBadge = label === "Messages" && dmUnread > 0 ? dmUnread : null;
                return (
                  <li key={label}>
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
                      <span className="flex items-center gap-2">
                        {label}
                        {dmBadge !== null && (
                          <span
                            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-negative px-1.5 font-mono text-2xs font-bold text-white"
                            aria-label={`${dmBadge} unread messages`}
                          >
                            {dmBadge > 9 ? "9+" : dmBadge}
                          </span>
                        )}
                      </span>
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
            </ul>
          </div>
        </>
      )}
    </header>
  );
}
