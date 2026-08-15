"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Gamepad2, Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getGameBackend } from "@/lib/config";

const LINKS = [
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
            variant={backend === "genlayer" ? "gold" : "secondary"}
            className="hidden md:inline-flex"
            title={
              backend === "genlayer"
                ? "Playing on the GenLayer network"
                : "Playing with the built-in offline backend (no chain required)"
            }
          >
            {backend === "genlayer" ? "● on GenLayer" : "● local mode"}
          </Badge>
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
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
