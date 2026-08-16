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

  const configured = supabaseClientConfigured();
  const guest = useMemo(() => getGuestIdentity(), []);

  const startAsGuest = useCallback(() => {
    router.push(returnTo.startsWith("/") ? returnTo : "/create");
  }, [router, returnTo]);

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
    setBusy(true);
    try {
      const { error: sendError } = await sb.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          shouldCreateUser: mode === "create",
        },
      });
      if (sendError) throw sendError;
      setStep("code");
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "We couldn't send a code to that email. Please try again.";
      setError(message.replace(/^AuthApiError:\s*/i, ""));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (code.trim().length < 6) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    const sb = getSupabaseBrowser();
    if (!sb) return;
    setBusy(true);
    try {
      const { data, error: verifyError } = await sb.auth.verifyOtp({
        email: cleanEmail,
        token: code.trim(),
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

      setStep("done");
      await identity.refresh();
      setTimeout(() => {
        router.push(returnTo.startsWith("/") ? returnTo : "/profile");
      }, 350);
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "That code didn't work. Check the email and try again.";
      setError(message);
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
                We sent a 6-digit code to <span className="text-foreground/90">{email.trim().toLowerCase()}</span>
                {mode === "create" && (
                  <> to verify your username <span className="font-mono text-primary">{username.trim()}</span></>
                )}
                .
              </p>
            </div>
            <Input
              inputMode="numeric"
              autoFocus
              maxLength={6}
              placeholder="000000"
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
              <button
                type="button"
                onClick={() => void sendCode()}
                disabled={busy}
                className="text-primary underline-offset-2 hover:underline"
              >
                Resend code
              </button>
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
