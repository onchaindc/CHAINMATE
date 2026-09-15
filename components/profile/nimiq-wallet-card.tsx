"use client";

/**
 * Nimiq wallet card — Phase 1B profile integration.
 *
 * A single panel on the profile page: shows connected/not-connected, the
 * shortened bound address, and the real connect/unlink actions driven by the
 * Nimiq Pay provider flow. No fake states — everything rendered comes from
 * the server's binding record or the provider hook.
 */

import { Link2, Loader2, Unlink, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  useNimiqWallet,
  shortNimiqAddress,
  type WalletLinkPhase,
} from "@/hooks/use-nimiq-wallet";
import { NIMIQ_ENABLED } from "@/lib/nimiq/config";

const BUSY_PHASES: ReadonlySet<WalletLinkPhase> = new Set([
  "awaiting-wallet",
  "verifying",
]);

export function NimiqWalletCard({ playerId }: { playerId: string }) {
  const {
    provider,
    wallet,
    loaded,
    phase,
    error,
    setError,
    link,
    unlink,
  } = useNimiqWallet(playerId);

  // Feature off (or mounting before the flag is read): render nothing rather
  // than a card advertising a disabled capability.
  if (!NIMIQ_ENABLED) return null;

  const busy = BUSY_PHASES.has(phase);
  const connected = wallet !== null;

  return (
    <Panel className="mt-4 animate-fade-in-up px-4 py-3.5 [animation-delay:80ms]">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-secondary/50"
        >
          <Wallet className="h-4 w-4 text-muted-foreground" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Nimiq wallet
          </p>
          {connected ? (
            <p className="truncate font-mono text-sm text-foreground" title={wallet!.address}>
              {shortNimiqAddress(wallet!.address)}
              <span className="ml-2 font-sans text-2xs uppercase text-primary">Connected</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {loaded ? "Not connected" : "Checking…"}
            </p>
          )}
        </div>

        {connected ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              void unlink();
            }}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Unlink className="h-3.5 w-3.5" aria-hidden />
            )}
            Unlink
          </Button>
        ) : (
          <Button size="sm" disabled={busy || provider !== "available"} onClick={() => void link()}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {phase === "verifying" ? "Verifying…" : "Check your wallet"}
              </>
            ) : (
              <>
                <Link2 className="h-3.5 w-3.5" aria-hidden />
                Connect
              </>
            )}
          </Button>
        )}
      </div>

      {/* Replacement flow: an explicit second tap replaces the bound wallet. */}
      {connected && wallet && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
          <p className="text-2xs text-muted-foreground">
            Bound on {wallet.network === "main" ? "Mainnet" : "Testnet"} ·{" "}
            {new Date(wallet.linkedAt).toLocaleDateString()}
          </p>
          <button
            type="button"
            disabled={busy || provider !== "available"}
            onClick={() => void link({ replace: true })}
            className="text-2xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Replace wallet…
          </button>
        </div>
      )}

      {provider !== "available" && !connected && (
        <p className="mt-2 text-2xs text-muted-foreground">
          {provider === "web-unavailable"
            ? "Open ChainMate inside Nimiq Pay to connect your wallet."
            : provider === "unavailable"
              ? "Nimiq is disabled on this deployment."
              : provider === "detecting"
                ? "Looking for the Nimiq provider…"
                : "Nimiq wallet could not be reached."}
        </p>
      )}

      {error && (
        <div className="mt-2 flex items-start justify-between gap-2">
          <p className="text-2xs text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-2xs text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}
    </Panel>
  );
}
