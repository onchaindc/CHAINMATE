"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ArrowRight, ChevronLeft, ShieldCheck } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { useIdentity } from "@/lib/identity-context";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { supabaseClientConfigured } from "@/lib/supabase/config";
import { getGuestIdentity, setAuthIdentity } from "@/lib/identity";
import { cn } from "@/lib/utils";

type Mode = "guest" | "create" | "signin";
type Step = "form" | "code" | "done";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PENDING_KEY = "chainmate:pending-auth:v1";

/** The auth intent stored when a code is requested, so a magic link clicked
 * later (from the email) can finish the same flow — including the chosen
 * username for account creation.
 *
 * Written to BOTH sessionStorage and localStorage: the email link opens in a
 * new tab/webview, which does not share sessionStorage with the tab that
 * requested the code — localStorage is the cross-tab channel. Cleared on use. */
function readPendingAuth(): { mode: Mode; username: string; returnTo: string } | null {
  if (typeof window === "undefined") return null;
  const raw =
    window.sessionStorage.getItem(PENDING_KEY) ?? window.localStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: string; username?: string; returnTo?: string };
    if (!parsed.mode || (parsed.mode !== "create" && parsed.mode !== "signin")) return null;
    return {
      mode: parsed.mode,
      username: parsed.username ?? "",
      returnTo: parsed.returnTo ?? "/profile",
    };
  } catch {
    return null;
  }
}

function writePendingAuth(mode: Mode, username: string, returnTo: string) {
  if (typeof window === "undefined") return;
  const value = JSON.stringify({ mode, username, returnTo });
  try {
    window.sessionStorage.setItem(PENDING_KEY, value);
  } catch {
    // ignore
  }
  try {
    window.localStorage.setItem(PENDING_KEY, value);
  } catch {
    // ignore
  }
}

function clearPendingAuth() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex w-full max-w-md items-center justify-center px-4 py-40">
          <span className="h-8 w-8 animate-pulse rounded-full bg-secondary/60" aria-hidden />
        </div>
      }
    >
      <AuthContent />
    </Suspense>
  );
}

function AuthContent() {
  const router = useRouter();
  const params = useSearchParams();
  const identity = useIdentity();

  const upgrade = params.get("upgrade") === "1";
  const returnTo = params.get("returnTo") ?? "/profile";

  // Present when the user clicked the "Sign in" link from the email (magic
  // link): the app must verify it here, or the click does nothing.
  const tokenHash = params.get("token_hash");
  const tokenType = params.get("type") ?? "email";

  // Supabase sometimes delivers the token as a `#token_hash=` URL fragment
  // instead of a query param (useSearchParams only sees the query). Normalise
  // it into the same effective value used by the magic-link handler.
  const hashTokenHash =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token_hash")
      : null;
  const hashTokenType =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.hash.replace(/^#/, "")).get("type")
      : null;
  const effectiveTokenHash = tokenHash ?? hashTokenHash;
  const effectiveTokenType = tokenType ?? hashTokenType ?? "email";

  const [mode, setMode] = useState<Mode>(upgrade ? "create" : "guest");
  const [step, setStep] = useState<Step>("form");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameState, setUsernameState] = useState<
    "idle" | "checking" | "ok" | "taken" | "invalid"
  >("idle");
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Set when this environment can't reach Supabase (e.g. a restricted preview). */
  const [connectivityWarning, setConnectivityWarning] = useState<string | null>(null);

  /** Cooldown for the "Resend code" button — email sends are rate-limited. */
  const [resendAfter, setResendAfter] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!resendAfter) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [resendAfter]);

  const resendLeft = resendAfter ? Math.max(0, Math.ceil((resendAfter - now) / 1000)) : 0;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/identity/status");
        const data = (await res.json()) as { schemaError?: string | null };
        if (!cancelled && data.schemaError?.includes("fetch")) {
          setConnectivityWarning(
            "This preview environment can't reach the accounts service. Guest play works fine here — create your account on the deployed site or when running locally.",
          );
        }
      } catch {
        // offline — leave the warning off
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Human-readable errors, including honest explanations for network failures. */
  const friendlyAuthError = useCallback((err: unknown): string => {
    const message = err instanceof Error && err.message ? err.message : "";
    if (/failed to fetch|fetch failed|network|ENOTFOUND/i.test(message)) {
      return "Couldn't reach the accounts service — this preview can't connect to Supabase. Deploy the app or run it locally to create an account.";
    }
    if (/rate limit|rate_limit|over_email_send_rate_limit|too many/i.test(message)) {
      return "Too many emails were sent in the last hour, so the accounts service paused sends for now (they reset hourly). Wait a bit and try again, or raise the limit in Supabase under Authentication → Rate Limits.";
    }
    if (/expired|invalid/i.test(message)) {
      return "That code is invalid or has expired. Double-check the code from the email and try again, or request a new one.";
    }
    return (message || "Something went wrong. Please try again.").replace(/^AuthApiError:\s*/i, "");
  }, []);

  const configured = supabaseClientConfigured();
  const guest = useMemo(() => getGuestIdentity(), []);

  const startAsGuest = useCallback(() => {
    router.push(returnTo.startsWith("/") ? returnTo : "/create");
  }, [router, returnTo]);

  /** Magic link handling: clicking "Sign in" in the email lands here with a
   * token_hash. Verify it and finish the flow (including linking the guest
   * identity when the link was requested from Create account). */
  const magicLinkHandled = useRef(false);
  useEffect(() => {
    if (!effectiveTokenHash || magicLinkHandled.current) return;
    const sb = getSupabaseBrowser();
    if (!sb) return;
    magicLinkHandled.current = true;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const { data, error: verifyError } = await sb.auth.verifyOtp({
          token_hash: effectiveTokenHash,
          type: effectiveTokenType,
        });
        if (verifyError) throw verifyError;
        const session = data.session;
        if (!session) throw new Error("We couldn't start your session. Try again.");

        const pending = readPendingAuth();
        if (pending?.mode === "create" && pending.username) {
          // Guest → account: carry all real progress into the new profile.
          const res = await fetch("/api/identity/link", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ username: pending.username, playerId: guest.playerId }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) {
            throw new Error(body.error ?? "We couldn't save your profile. Please try again.");
          }
        } else {
          setAuthIdentity({
            userId: session.user.id,
            playerId: guest.playerId,
            username: "",
            rating: 0,
            accessToken: session.access_token,
          });
        }

        clearPendingAuth();
        // Drop the one-time token from the URL so a refresh doesn't re-verify it.
        window.history.replaceState(null, "", "/auth");
        setStep("done");
        await identity.refresh();
        const target =
          pending?.returnTo && pending.returnTo.startsWith("/") ? pending.returnTo : returnTo;
        setTimeout(() => {
          router.replace(target.startsWith("/") ? target : "/profile");
        }, 250);
      } catch (err) {
        setBusy(false);
        setError(friendlyAuthError(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenHash, tokenType, guest.playerId]);

  // Live username availability check (only when accounts are configured).
  useEffect(() => {
    if (mode !== "create" || username.trim().length < 3) {
      setUsernameState("idle");
      return;
    }
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setUsernameState("checking");
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/identity/username?value=${encodeURIComponent(username.trim())}`);
        if (!res.ok) {
          setUsernameState("idle"); // service unreachable — skip the hint
          return;
        }
        const data = (await res.json()) as { available?: boolean; reason?: string };
        setUsernameState(data.available ? "ok" : "taken");
      } catch {
        setUsernameState("idle");
      }
    }, 400);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [username, mode]);

  const sendCode = async () => {
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      setError("That email address doesn't look right. Double-check it and try again.");
      return;
    }
    if (mode === "create") {
      const trimmed = username.trim();
      if (trimmed.length < 3) {
        setError("Choose a username first — at least 3 characters.");
        return;
      }
      if (usernameState === "taken") {
        setError("That username is already taken. Try another.");
        return;
      }
      if (usernameState === "invalid") {
        setError("Use letters, numbers and underscores only (3–20 characters).");
        return;
      }
    }
    const sb = getSupabaseBrowser();
    if (!sb) {
      setError("Accounts aren't configured on this deployment yet.");
      return;
    }
    // Remember the intent so a magic link clicked later (from the email) can
    // finish the same flow — including the chosen username for Create account.
    writePendingAuth(mode, mode === "create" ? username.trim() : "", returnTo);
    setBusy(true);
    try {
      const { error: sendError } = await sb.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          shouldCreateUser: mode === "create",
          // Send the magic link back to the auth page, where the app verifies
          // it and completes the flow (in addition to the one-time code).
          emailRedirectTo: `${window.location.origin}/auth`,
        },
      });
      if (sendError) throw sendError;
      setStep("code");
      setResendAfter(Date.now() + 30_000);
      setNow(Date.now());
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    const digits = code.trim();
    // The email OTP length is a Supabase project setting (6 or 8 digits).
    // Accept 6–10 so a project-side length change never breaks sign-in;
    // Supabase's verifyOtp is the authority on what's actually valid.
    if (digits.length < 6 || digits.length > 10) {
      setError("Enter the code from the email (6–10 digits).");
      return;
    }
    const sb = getSupabaseBrowser();
    if (!sb) return;
    setBusy(true);
    try {
      const { data, error: verifyError } = await sb.auth.verifyOtp({
        email: cleanEmail,
        token: digits,
        type: "email",
      });
      if (verifyError) throw verifyError;
      const session = data.session;
      if (!session) throw new Error("We couldn't start your session. Try again.");

      if (mode === "create") {
        // Guest → account: carry all real progress into the new profile.
        const res = await fetch("/api/identity/link", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            username: username.trim(),
            playerId: guest.playerId,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(
            body.error ?? "We couldn't save your profile. Please try again.",
          );
        }
      } else {
        // Sign-in: record the session; the identity provider resolves the profile.
        setAuthIdentity({
          userId: session.user.id,
          playerId: guest.playerId,
          username: "",
          rating: 0,
          accessToken: session.access_token,
        });
      }

      clearPendingAuth();
      setStep("done");
      await identity.refresh();
      setTimeout(() => {
        router.push(returnTo.startsWith("/") ? returnTo : "/profile");
      }, 350);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const usernameHint =
    usernameState === "ok"
      ? "Username available"
      : usernameState === "taken"
        ? "That username is taken"
        : usernameState === "checking"
          ? "Checking…"
          : null;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6 lg:py-20">
      <div className="animate-fade-in-up">
        <p className="text-center text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">
          <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
          Player account
        </p>
        <h1 className="font-display mt-3 text-center text-3xl font-bold tracking-tight">
          {mode === "create" ? "Create your account" : mode === "signin" ? "Welcome back" : "Play chess."}
        </h1>

        {upgrade && identity.isGuest && (
          <div className="mt-6 rounded-lg border border-border/70 bg-card/50 px-4 py-3 text-sm text-foreground/85">
            You&rsquo;re playing as <span className="font-mono text-primary">{identity.username || "Guest"}</span>
            {identity.rating !== null ? (
              <> — currently {identity.rating} ELO. Creating an account keeps your rating,
              games and achievements.</>
            ) : (
              <> — creating an account keeps your games and progress.</>
            )}
          </div>
        )}
      </div>

      {/* Mode switch */}
      <div className="mt-8 grid animate-fade-in-up grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 [animation-delay:60ms]">
        {(
          [
            { id: "guest" as Mode, label: "Guest" },
            { id: "create" as Mode, label: "Create" },
            { id: "signin" as Mode, label: "Sign in" },
          ]
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setMode(m.id);
              setStep("form");
              setError(null);
            }}
            className={cn(
              "px-3 py-2.5 text-sm font-medium transition-colors",
              mode === m.id
                ? "bg-card text-foreground"
                : "bg-card/30 text-muted-foreground hover:text-foreground",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="mt-4 animate-fade-in-up rounded-lg border border-border/70 bg-card/50 p-6 [animation-delay:120ms]">
        {connectivityWarning && mode !== "guest" && (
          <div className="mb-4 rounded-md border border-border/60 bg-secondary/20 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            {connectivityWarning}
          </div>
        )}
        {!configured && mode !== "guest" ? (
          <div className="flex flex-col items-center py-8 text-center">
            <p className="text-sm font-medium text-foreground/85">
              Accounts aren&rsquo;t configured on this deployment yet
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              You can keep playing as a guest — your games and rating are saved
              on this device.
            </p>
            <Button className="mt-5" onClick={startAsGuest}>
              Play as guest <ArrowRight aria-hidden />
            </Button>
          </div>
        ) : mode === "guest" ? (
          <div className="flex flex-col items-center py-4 text-center">
            <PlayerAvatar name={identity.username || "Guest"} size="lg" />
            <p className="font-mono mt-3 text-lg font-semibold text-foreground">
              {identity.username || guest.username}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {identity.rating !== null ? (
                <>
                  {identity.rating} ELO · progress saved on this device
                </>
              ) : (
                "Anonymous player · progress saved on this device"
              )}
            </p>
            <Button size="lg" className="mt-6 w-full" onClick={startAsGuest}>
              Play as guest <ArrowRight aria-hidden />
            </Button>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              No email, no password. You can create an account later to keep
              your rating and games permanently.
            </p>
          </div>
        ) : step === "code" ? (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => {
                setStep("form");
                setCode("");
                setError(null);
              }}
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Back
            </button>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Check your email</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                We sent a verification code to <span className="text-foreground/90">{email.trim().toLowerCase()}</span>
                {mode === "create" && (
                  <> to verify your username <span className="font-mono text-primary">{username.trim()}</span></>
                )}
                .
              </p>
            </div>
            <Input
              inputMode="numeric"
              autoFocus
              maxLength={10}
              placeholder="00000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && !busy && void verifyCode()}
              className="font-mono text-center text-lg tracking-[0.5em]"
              aria-label="Verification code"
            />
            <Button onClick={() => void verifyCode()} disabled={busy || code.trim().length < 6}>
              {busy ? "Verifying…" : "Verify and continue"}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              Didn&rsquo;t get it?{" "}
              {resendLeft > 0 ? (
                <span className="text-muted-foreground/70">
                  You can resend in {resendLeft}s
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendCode()}
                  disabled={busy}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Resend code
                </button>
              )}
            </p>
            <p className="text-center text-[11px] leading-relaxed text-muted-foreground/80">
              Tip: if the email shows a <span className="text-foreground/80">Sign in</span>{" "}
              button instead of a code, click it — it opens this page and signs
              you in automatically.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {mode === "create" && (
              <div>
                <label
                  htmlFor="username"
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Username
                </label>
                <Input
                  id="username"
                  autoFocus
                  placeholder="GrandMaster7"
                  value={username}
                  maxLength={20}
                  onChange={(e) => {
                    setUsername(e.target.value.replace(/[^A-Za-z0-9_]/g, ""));
                    setUsernameState("idle");
                  }}
                  className="mt-1.5"
                />
                {usernameHint && (
                  <p
                    className={cn(
                      "mt-1.5 text-[11px]",
                      usernameState === "ok" && "text-primary",
                      usernameState === "taken" && "text-destructive",
                      usernameState === "checking" && "text-muted-foreground",
                    )}
                  >
                    {usernameHint}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  3–20 characters · letters, numbers, underscores. Your public
                  name — your email stays private.
                </p>
              </div>
            )}
            <div>
              <label
                htmlFor="email"
                className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && void sendCode()}
                className="mt-1.5"
              />
            </div>
            <Button onClick={() => void sendCode()} disabled={busy}>
              {busy ? "Sending code…" : "Continue"}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              {mode === "create"
                ? "We'll email you a one-time code. No password needed."
                : "We'll email you a one-time code to sign in."}
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </div>

      <p className="mt-6 animate-fade-in-up text-center text-[11px] text-muted-foreground [animation-delay:180ms]">
        <Link href="/" className="underline-offset-2 hover:underline">
          ← Back to ChainMate
        </Link>
      </p>
    </div>
  );
}
