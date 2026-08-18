import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { HeroPreview } from "@/components/home/hero-preview";
import { useIdentity } from "@/lib/identity-context";
import { cn } from "@/lib/utils";

export function Hero() {
  const identity = useIdentity();
  const isAuthed = !identity.isGuest && identity.username && identity.username.trim().length > 0;

  return (
    <section className="relative">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:py-20">
        <div className="animate-fade-in-up max-w-xl">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            Secured by GenLayer
          </p>
          <h1 className="font-display mt-6 text-4xl font-bold leading-[1.06] tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
            Play chess.
            <br />
            <span className="text-primary">Think deeper.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            Competitive chess with intelligent analysis. Every move is validated
            by an intelligent contract on GenLayer, and every game ends with a
            clear report on how it was won.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {isAuthed ? (
              <>
                <Link
                  href="/create"
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    "bg-primary text-primary-foreground shadow-lg shadow-primary/10 hover:bg-primary/90",
                  )}
                >
                  <Play className="h-4 w-4" aria-hidden />
                  Play
                </Link>
                <Link
                  href="/profile"
                  className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
                >
                  Profile
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </>
            ) : (
              <>
                <Link
                  href="/auth"
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    "bg-primary text-primary-foreground shadow-lg shadow-primary/10 hover:bg-primary/90",
                  )}
                >
                  Sign Up
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <Link
                  href="/auth?mode=signin"
                  className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
                >
                  Sign In
                </Link>
                <Link
                  href="/create"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "lg" }),
                    "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Play as Guest
                </Link>
              </>
            )}
          </div>
          {!isAuthed && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Sign up to save your rating, history and achievements across devices.
            </p>
          )}
        </div>
        <div className="animate-fade-in-up [animation-delay:100ms]">
          <HeroPreview />
        </div>
      </div>
    </section>
  );
}
