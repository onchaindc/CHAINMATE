"use client";

/**
 * TEMPORARY developer diagnostic — "Test 0.1 NIM Payment".
 *
 * Answers exactly one question: can ChainMate, running inside Nimiq Pay,
 * drive the REAL sendBasicTransaction() on the user's connected wallet?
 * The wallet's own native confirmation sheet mediates the send — nothing is
 * constructed or signed here, no key is touched, and the payment
 * confirmation is never bypassed.
 *
 * Visible only inside a Nimiq host (Nimiq Pay injects the provider) or in
 * developer mode (`?nimiqDiag=1`), so it never appears as a production
 * action. Displays init/listAccounts/address/network capability facts and
 * the EXACT provider error on failure — but never keys, secrets, or the
 * provider object itself (the capability check is a typeof, nothing more).
 */

import { useCallback, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import {
  connectNimiq,
  listNimiqAccounts,
  sendNimiqBasicTransaction,
  type NimiqWalletError,
} from "@/lib/nimiq/miniapp";
import {
  NIMIQ_NETWORK,
  NIMIQ_TREASURY_ADDRESS,
  isPlausibleNimiqAddress,
} from "@/lib/nimiq/config";
import {
  TEST_PAYMENT_LUNA,
  TEST_PAYMENT_NIM,
  classifySendOutcome,
  sendOutcomeHeadline,
  type SendOutcome,
} from "@/lib/nimiq/payment-diagnostic";
import { hasNimiqHost } from "@/hooks/use-nimiq";

/** Dev-mode override so the block can be inspected in a plain browser too. */
export function isNimiqDiagnosticVisible(): boolean {
  if (typeof window === "undefined") return false;
  if (hasNimiqHost()) return true;
  try {
    return new URLSearchParams(window.location.search).get("nimiqDiag") === "1";
  } catch {
    return false;
  }
}

/** Everything the diagnostic learned, rendered as it happened. */
interface DiagState {
  initOk: boolean;
  providerAvailable: boolean;
  methodExists: boolean;
  accounts: string[];
  sender: string | null;
  outcome: SendOutcome | null;
  lookup: {
    status: string;
    label: string;
    confirmations: number;
    rpcConfigured: boolean;
  } | null;
}

const INITIAL: DiagState = {
  initOk: false,
  providerAvailable: false,
  methodExists: false,
  accounts: [],
  sender: null,
  outcome: null,
  lookup: null,
};

export function NimiqPaymentDiagnostic() {
  const identity = useIdentity();
  const [visible] = useState(isNimiqDiagnosticVisible);
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<DiagState>(INITIAL);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    setState(INITIAL);
    try {
      // 1. Existing init path (same wrapper the connect flow uses).
      const connected = await connectNimiq(8_000);
      if (!connected.ok) {
        setState((s) => ({ ...s, initOk: false, providerAvailable: false }));
        setFailure(connected.error.message);
        return;
      }
      const nimiq = connected.value;
      const methodExists =
        typeof (nimiq as { sendBasicTransaction?: unknown }).sendBasicTransaction ===
        "function";

      // 2. Accounts.
      const accountsRes = await listNimiqAccounts(nimiq);
      const accounts = accountsRes.ok ? accountsRes.value : [];
      const sender = accounts[0] ?? null;

      setState({
        initOk: true,
        providerAvailable: true,
        methodExists,
        accounts,
        sender,
        outcome: null,
        lookup: null,
      });

      if (accounts.length === 0) {
        setFailure("The wallet reports no accounts. Create one in Nimiq Pay and retry.");
        return;
      }
      if (!methodExists) {
        return; // the capability verdict IS the result
      }

      // 3. The REAL send. Nimiq Pay shows its native confirmation sheet;
      //    value is luna, the wire conversion lives in the existing wrapper.
      const send = await sendNimiqBasicTransaction(nimiq, {
        recipient: NIMIQ_TREASURY_ADDRESS,
        value: TEST_PAYMENT_LUNA,
      });

      const outcome = classifySendOutcome({
        providerAvailable: true,
        methodExists,
        sendError: send.ok ? null : (send.error as NimiqWalletError),
        txHash: send.ok ? send.value : null,
      });
      setState((s) => ({ ...s, outcome }));

      // 4. Hash in hand → the small diagnostic lookup (never the production
      //    verifier: this consumes nothing).
      if (outcome.kind === "submitted" && outcome.txHash) {
        setChecking(true);
        try {
          const token = getIdentityToken();
          const res = await fetch("/api/nimiq/diagnose-tx", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ playerId: identity.playerId, txHash: outcome.txHash }),
          });
          const data = (await res.json().catch(() => ({}))) as DiagState["lookup"] & {
            error?: string;
          };
          if (res.ok && data && !data.error) {
            setState((s) => ({ ...s, lookup: data }));
          } else {
            setFailure(data?.error ?? "On-chain lookup failed");
          }
        } finally {
          setChecking(false);
        }
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Diagnostic failed");
    } finally {
      setRunning(false);
    }
  }, [identity.playerId]);

  if (!visible) return null;
  const treasuryOk = isPlausibleNimiqAddress(NIMIQ_TREASURY_ADDRESS);

  return (
    <Panel className="mt-3 border-dashed px-4 py-3.5">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-3.5 w-3.5 text-warning" aria-hidden />
        <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Developer diagnostic
        </p>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
          )}
          Test 0.1 NIM Payment
        </Button>
      </div>
      <p className="mt-1.5 text-2xs leading-snug text-muted-foreground">
        Temporary capability test: sends exactly {TEST_PAYMENT_NIM} NIM (
        {TEST_PAYMENT_LUNA.toString()} luna) to the configured treasury through
        Nimiq Pay&apos;s own confirmation. Nimiq Pay mediates the send; nothing is
        signed or constructed here.
      </p>

      {/* Capability facts — each line states one observed fact. */}
      {(state.initOk || state.accounts.length > 0 || failure) && (
        <dl className="mt-3 space-y-1 text-2xs">
          <Fact label="init()" ok={state.initOk} />
          <Fact label="Provider available" ok={state.providerAvailable} />
          <Fact label="sendBasicTransaction exists" ok={state.methodExists} />
          {state.accounts.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-44 shrink-0 text-muted-foreground">listAccounts()</dt>
              <dd className="min-w-0 break-all font-mono">
                {state.accounts.length} account(s)
                {state.sender && (
                  <>
                    {" "}
                    · sender{" "}
                    <span title={state.sender}>{state.sender}</span>
                  </>
                )}
              </dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-44 shrink-0 text-muted-foreground">Destination</dt>
            <dd className="min-w-0 break-all font-mono">
              {treasuryOk ? (
                NIMIQ_TREASURY_ADDRESS || "(not configured)"
              ) : (
                <span className="text-destructive">
                  {NIMIQ_TREASURY_ADDRESS || "NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS not configured"}
                </span>
              )}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 shrink-0 text-muted-foreground">Amount / network</dt>
            <dd className="font-mono">
              {TEST_PAYMENT_NIM} NIM · {NIMIQ_NETWORK}
            </dd>
          </div>
        </dl>
      )}

      {/* The verdict. */}
      {state.outcome && (
        <div className="mt-3 rounded-md border border-border/60 bg-secondary/30 px-3 py-2">
          <p className="text-2xs font-semibold">{sendOutcomeHeadline(state.outcome.kind)}</p>
          {state.outcome.kind === "submitted" && state.outcome.txHash && (
            <div className="mt-1.5 space-y-0.5 break-all font-mono text-2xs text-muted-foreground">
              <p>Transaction submitted</p>
              <p>TX: {state.outcome.txHash}</p>
              {state.sender && <p>From: {state.sender}</p>}
              <p>To: {NIMIQ_TREASURY_ADDRESS}</p>
              <p>Amount: {TEST_PAYMENT_NIM} NIM</p>
            </div>
          )}
          {state.outcome.providerError && (
            <p className="mt-1.5 break-words text-2xs text-destructive">
              Provider error: {state.outcome.providerError}
            </p>
          )}
        </div>
      )}

      {/* Where the hash actually stands. */}
      {state.lookup && (
        <div className="mt-2 rounded-md border border-border/60 px-3 py-2">
          <p className="text-2xs font-semibold">On-chain lookup</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {state.lookup.rpcConfigured ? state.lookup.label : state.lookup.label}
            {state.lookup.rpcConfigured && state.lookup.confirmations > 0 && (
              <> · {state.lookup.confirmations} confirmation(s)</>
            )}
          </p>
          {checking && (
            <p className="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking the node…
            </p>
          )}
          {!state.lookup.rpcConfigured && (
            <p className="mt-1 text-2xs text-muted-foreground">
              Set NIMIQ_RPC_URL on the server to enable on-chain lookups.
            </p>
          )}
        </div>
      )}

      {failure && <p className="mt-2 text-2xs text-destructive">{failure}</p>}
    </Panel>
  );
}

function Fact({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-44 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={ok ? "text-positive" : "text-destructive"}>{ok ? "yes" : "no"}</dd>
    </div>
  );
}
