import Link from "next/link";
import { Code2, Gamepad2 } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Gamepad2 className="h-4 w-4 text-primary" aria-hidden />
          <span>
            ChainMate — chess, refereed by an intelligent contract on GenLayer.
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/create" className="transition-colors hover:text-foreground">
            Create
          </Link>
          <Link href="/join" className="transition-colors hover:text-foreground">
            Join
          </Link>
          <a
            href="https://docs.genlayer.com"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-foreground"
          >
            GenLayer docs
          </a>
          <span className="flex items-center gap-1.5">
            <Code2 className="h-4 w-4" aria-hidden />
            onchaindc/CHAINMATE
          </span>
        </div>
      </div>
    </footer>
  );
}
