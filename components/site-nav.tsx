"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Gamepad2, Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getGameBackend } from "@/lib/config";

const LINKS = [
  { href: "/create?mode=ai", label: "Play vs AI", icon: Bot },
  { href: "/create", label: "Create game", icon: Plus },
  { href: "/join", label: "Join game", icon: Users },
];

export function SiteNav() {
  const pathname = usePathname();
  const backend = getGameBackend();

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/25 transition-transform group-hover:scale-105">
            <Gamepad2 className="h-5 w-5" aria-hidden />
          </span>
          <span className="font-display text-lg font-bold tracking-tight">
            ChainMate
          </span>
        </Link>

        <nav className="flex items-center gap-1.5 sm:gap-3">
          <Badge
            variant={backend === "local" ? "secondary" : "gold"}
            className="hidden md:inline-flex"
            title={
              backend === "genlayer"
                ? "Playing on the GenLayer network"
                : backend === "hosted"
                  ? "Playing through the shared multiplayer store (Vercel KV)"
                  : "Playing with the built-in offline backend (same-browser only)"
            }
          >
            {backend === "genlayer"
              ? "● on GenLayer"
              : backend === "hosted"
                ? "● online mode"
                : "● local mode"}
          </Badge>
          {LINKS.map(({ href, label, icon: Icon }) => {
            const path = href.split("?")[0];
            const active = pathname.startsWith(path);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }),
                  "hidden sm:inline-flex",
                )}
              >
                <Icon aria-hidden />
                {label}
              </Link>
            );
          })}
          <Link
            href="/create"
            aria-label="Create game"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "sm:hidden")}
          >
            <Plus aria-hidden />
          </Link>
        </nav>
      </div>
    </header>
  );
}
