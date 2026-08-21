"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, LogOut, Trophy } from "lucide-react";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { useIdentity } from "@/lib/identity-context";
import { cn } from "@/lib/utils";

/**
 * Compact player identity in the navbar:
 *  - guest:  avatar + Guest_XXXX (+ rating when known) → Profile / Games /
 *            Save your progress / Sign in
 *  - user:   avatar + username + rating → Profile / Games / Sign out
 */
export function PlayerMenu() {
  const identity = useIdentity();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (identity.status === "loading") {
    return <span className="h-7 w-7 animate-pulse rounded-full bg-secondary/60" aria-hidden />;
  }

  const name = identity.username || "Player";
  const isGuest = identity.isGuest;

  const close = () => setOpen(false);

  const signOut = async () => {
    close();
    await identity.signOut();
    router.push("/");
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Account menu — signed in as ${name}`}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 rounded-full border border-border/70 py-1 pl-1 pr-2 transition-all active:scale-[0.97]",
          "hover:border-border hover:bg-secondary/40",
          open && "border-border bg-secondary/40",
        )}
      >
        <PlayerAvatar name={name} />
        <span className="hidden max-w-28 truncate text-sm text-foreground/90 sm:block">
          {name}
        </span>
        {identity.rating !== null && (
          <span className="hidden items-center gap-1 font-mono text-xs tabular-nums text-primary lg:flex">
            <Trophy className="h-3 w-3" aria-hidden />
            {identity.rating}
          </span>
        )}
        <ChevronDown
          className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 animate-fade-in-up overflow-hidden rounded-lg border border-border/70 bg-card/95 shadow-elevation-3 backdrop-blur">
          <div className="border-b border-border/60 px-4 py-3">
            <p className="truncate text-sm font-medium text-foreground">{name}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {isGuest ? (
                <>
                  Guest — progress saved on this device.
                  {identity.rating !== null && (
                    <span className="ml-1 font-mono text-primary">{identity.rating} ELO</span>
                  )}
                </>
              ) : (
                <>
                  Player account
                  {identity.rating !== null && (
                    <span className="ml-1 font-mono text-primary">{identity.rating} ELO</span>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="py-1">
            <Link
              href="/profile"
              onClick={close}
              className="block px-4 py-2 text-sm text-foreground/85 transition-all hover:bg-secondary/50 active:scale-[0.98]"
            >
              Profile
            </Link>
            <Link
              href="/games"
              onClick={close}
              className="block px-4 py-2 text-sm text-foreground/85 transition-all hover:bg-secondary/50 active:scale-[0.98]"
            >
              Games
            </Link>
            {isGuest ? (
              <>
                <Link
                  href="/auth?upgrade=1"
                  onClick={close}
                  className="block border-t border-border/50 px-4 py-2 text-sm text-primary transition-colors hover:bg-secondary/50"
                >
                  Save your progress
                </Link>
                <Link
                  href="/auth"
                  onClick={close}
                  className="block px-4 py-2 text-sm text-foreground/85 transition-colors hover:bg-secondary/50"
                >
                  Sign in
                </Link>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void signOut()}
                className="flex w-full items-center gap-2 border-t border-border/50 px-4 py-2 text-left text-sm text-foreground/85 transition-colors hover:bg-secondary/50"
              >
                <LogOut className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                Sign out
              </button>
            )}
          </div>
          {/* The navbar toggle is hidden below sm, so mobile reaches it here. */}
          <div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5 sm:hidden">
            <span className="text-xs text-muted-foreground">Theme</span>
            <ThemeToggle />
          </div>
        </div>
      )}
    </div>
  );
}
