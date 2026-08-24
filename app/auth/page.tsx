"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { ErrorNote } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { supabaseClientConfigured } from "@/lib/supabase/config";
import type { Session } from "@supabase/supabase-js";
import { getGuestIdentity, setAuthIdentity } from "@/lib/identity";
import { cn } from "@/lib/utils";

type Step = "form" | "google-onboarding" | "done";

const PENDING_KEY = "chainmate:pending-auth:v1";
const OAUTH_FLAG = "chainmate:oauth:v1";

/**
 * Where "Play as Guest" starts a guest off, matching both landing-page
 * Play-as-Guest buttons. Every visitor already has a guest identity
 * (identity.ts), so the button needs a destination, not a sign-up step.
 */
const GUEST_START = "/create";

/**
 * The RequireProfile-wrapped routes. A guest sent to one of these is bounced
 * straight back to /auth, so no guest navigation may ever resolve to them.
 * Keep in sync with the pages that wrap themselves in RequireProfile.
 */
const ACCOUNT_ONLY = ["/profile", "/games", "/play"];

function GoogleGIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4">
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.28 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.27a12 12 0 0 0 0 10.78l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.61l4.01 3.1C6.22 6.88 8.87 4.77 12 4.77z" />
    </svg>
  );
}

/**
 * The username and destination stashed before the Google redirect.
 *
 * Written and cleared, but — until now — never read, which is a real bug and not
 * just an unused function: `redirectTo` is a bare `${origin}/auth`, so the
 * `returnTo` query param does not survive the round trip through Google. Every
 * player who signed in from a game invite came back with no param and was sent
 * to their profile instead of the game they were invited to. This is the copy
 * that does survive.
 */
function readPendingAuth(): { username: string; returnTo: string } | null {
  if (typeof window === "undefined") return null;
  const raw =
    window.sessionStorage.getItem(PENDING_KEY) ?? window.localStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { username?: string; returnTo?: string };
    return { username: parsed.username ?? "", returnTo: parsed.returnTo ?? "/profile" };
  } catch {
    return null;
  }
}

function writePendingAuth(username: string, returnTo: string) {
  if (typeof window === "undefined") return;
  const value = JSON.stringify({ username, returnTo });
  try { window.sessionStorage.setItem(PENDING_KEY, value); } catch { /* ignore */ }
  try { window.localStorage.setItem(PENDING_KEY, value); } catch { /* ignore */ }
}

function clearPendingAuth() {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  try { window.localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
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
  const modeParam = params.get("mode");
  const returnToParam = params.get("returnTo");

  /**
   * Where to send the player once they're signed in.
   *
   * The query param when there is one, otherwise the copy stashed before the
   * Google redirect — coming back from Google there is no param at all. The
   * leading-slash test is the open-redirect guard, and it lives here, once,
   * rather than being repeated at each of the three navigations below.
   */
  const returnTo = useMemo(() => {
    if (returnToParam?.startsWith("/")) return returnToParam;
    const pending = readPendingAuth()?.returnTo;
    return pending?.startsWith("/") ? pending : "/profile";
  }, [returnToParam]);

  const [step, setStep] = useState<Step>("form");
  const [googleOnboardingToken, setGoogleOnboardingToken] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameState, setUsernameState] = useState<
    "idle" | "checking" | "ok" | "taken" | "invalid"
  >("idle");
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If user is already authenticated with a complete profile, redirect away.
  useEffect(() => {
    if (identity.status === "loading") return;
    if (!identity.isGuest && identity.username && identity.username.trim().length > 0) {
      router.replace(returnTo);
    }
  }, [identity.status, identity.isGuest, identity.username, router, returnTo]);

  // Live username availability check
  useEffect(() => {
    if (username.trim().length < 3) {
      setUsernameState("idle");
      return;
    }
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setUsernameState("checking");
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/identity/username?value=${encodeURIComponent(username.trim())}`);
        if (!res.ok) { setUsernameState("idle"); return; }
        const data = (await res.json()) as { available?: boolean; reason?: string };
        setUsernameState(data.available ? "ok" : "taken");
      } catch {
        setUsernameState("idle");
      }
    }, 400);
    return () => { if (checkTimer.current) clearTimeout(checkTimer.current); };
  }, [username]);

  const friendlyAuthError = useCallback((err: unknown): string => {
    const message = err instanceof Error && err.message ? err.message : "";
    if (/failed to fetch|fetch failed|network|ENOTFOUND/i.test(message)) {
      return "Couldn't reach the accounts service. Try again in a moment.";
    }
    return (message || "Something went wrong. Please try again.").replace(/^AuthApiError:\s*/i, "");
  }, []);

  /** Complete Google OAuth: link profile or trigger onboarding. */
  const completeGoogleAuth = useCallback(
    async (session: Session) => {
      try {
        const res = await fetch("/api/identity/link", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ google: true }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string; playerId?: string; needsOnboarding?: boolean;
          profile?: { player_id?: string; username?: string };
        };
        if (!res.ok) throw new Error(body.error ?? "We couldn't save your profile. Please try again.");
        if (body.needsOnboarding) {
          setGoogleOnboardingToken(session.access_token);
          setStep("google-onboarding");
          setBusy(false);
          return;
        }
        const profile = body.profile;
        setAuthIdentity({
          userId: session.user.id,
          playerId: body.playerId ?? profile?.player_id ?? getGuestIdentity().playerId,
          username: profile?.username ?? "",
          rating: 0,
          accessToken: session.access_token,
        });
        clearPendingAuth();
        window.history.replaceState(null, "", "/auth");
        setStep("done");
        await identity.refresh();
        setTimeout(() => { router.push(returnTo); }, 350);
      } catch (err) {
        setBusy(false);
        setError(friendlyAuthError(err));
      }
    },
    [identity, router, returnTo, friendlyAuthError],
  );

  /** Submit chosen username after Google onboarding. */
  const completeGoogleOnboarding = useCallback(async () => {
    setError(null);
    const trimmed = username.trim();
    if (trimmed.length < 3) { setError("Choose a username — at least 3 characters."); return; }
    if (usernameState === "taken") { setError("That username is already taken. Try another."); return; }
    if (usernameState === "invalid") { setError("Use letters, numbers and underscores only."); return; }
    if (!googleOnboardingToken) { setError("Session expired. Please sign in with Google again."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/identity/link", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${googleOnboardingToken}` },
        body: JSON.stringify({ google: true, username: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string; playerId?: string; profile?: { player_id?: string; username?: string };
      };
      if (!res.ok) throw new Error(body.error ?? "We couldn't save your profile. Please try again.");
      const profile = body.profile;
      // Decode the JWT to extract the Supabase user ID (sub claim).
      let decodedUserId = "";
      try {
        const payload = JSON.parse(atob(googleOnboardingToken.split(".")[1] ?? ""));
        decodedUserId = payload.sub ?? "";
      } catch { /* best-effort */ }
      setAuthIdentity({
        userId: decodedUserId,
        playerId: body.playerId ?? profile?.player_id ?? getGuestIdentity().playerId,
        username: profile?.username ?? trimmed,
        rating: 0,
        accessToken: googleOnboardingToken,
      });
      clearPendingAuth();
      window.history.replaceState(null, "", "/auth");
      setStep("done");
      setGoogleOnboardingToken(null);
      await identity.refresh();
      setTimeout(() => { router.push(returnTo); }, 350);
    } catch (err) {
      setBusy(false);
      setError(friendlyAuthError(err));
    }
  }, [username, usernameState, googleOnboardingToken, identity, router, returnTo, friendlyAuthError]);

  const startGoogleOAuth = useCallback(async () => {
    setError(null);
    const sb = getSupabaseBrowser();
    if (!sb) { setError("Accounts aren't configured on this deployment yet."); return; }
    try {
      window.sessionStorage.setItem(OAUTH_FLAG, String(Date.now()));
      writePendingAuth(username.trim(), returnTo);
      const { error: oauthError } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth`,
          queryParams: { access_type: "offline", prompt: "consent" },
        },
      });
      if (oauthError) throw oauthError;
    } catch (err) {
      setError(friendlyAuthError(err));
    }
  }, [username, returnTo, friendlyAuthError]);

  const configured = supabaseClientConfigured();

  /**
   * Guests keep `returnTo` only when they can actually use it — arriving from a
   * game invite is the case that matters, and the reason returnTo survives OAuth
   * at all.
   *
   * Never an account-only page. `returnTo` falls back to /profile, which is
   * RequireProfile-wrapped, so this button used to bounce the guest right back
   * to the sign-up screen — and the bounce appended ?returnTo=/profile, which
   * pinned them in the loop with no way out of it.
   */
  const startAsGuest = useCallback(() => {
    const accountOnly = ACCOUNT_ONLY.some(
      (route) => returnTo === route || returnTo.startsWith(`${route}/`),
    );
    router.push(accountOnly ? GUEST_START : returnTo);
  }, [router, returnTo]);

  // Google OAuth return handler — handles the race where SIGNED_IN fires
  // before the listener is registered (Supabase processes URL tokens on mount).
  const oauthHandled = useRef(false);
  useEffect(() => {
    const sb = getSupabaseBrowser();
    if (!sb || oauthHandled.current) return;

    const flag = window.sessionStorage.getItem(OAUTH_FLAG);
    if (!flag) return;
    if (Date.now() - Number(flag) > 10 * 60 * 1000) {
      window.sessionStorage.removeItem(OAUTH_FLAG);
      return;
    }

    // Check for an existing session first (Supabase may have already
    // processed the URL tokens before this effect ran).
    sb.auth.getSession().then(({ data: { session } }) => {
      if (oauthHandled.current) return;
      if (session && session.user.app_metadata?.provider === "google") {
        oauthHandled.current = true;
        window.sessionStorage.removeItem(OAUTH_FLAG);
        setBusy(true);
        setError(null);
        void completeGoogleAuth(session);
      }
    });

    // Also listen for late-arriving SIGNED_IN events.
    const { data: subscription } = sb.auth.onAuthStateChange((event, session) => {
      if (oauthHandled.current) return;
      if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION") return;
      if (!session || session.user.app_metadata?.provider !== "google") return;
      const f = window.sessionStorage.getItem(OAUTH_FLAG);
      if (!f) return;
      if (Date.now() - Number(f) > 10 * 60 * 1000) {
        window.sessionStorage.removeItem(OAUTH_FLAG);
        return;
      }
      oauthHandled.current = true;
      window.sessionStorage.removeItem(OAUTH_FLAG);
      setBusy(true);
      setError(null);
      void completeGoogleAuth(session);
    });
    return () => subscription.subscription.unsubscribe();
  }, [completeGoogleAuth]);

  const usernameHint =
    usernameState === "ok" ? "Username available"
    : usernameState === "taken" ? "That username is taken"
    : usernameState === "checking" ? "Checking…"
    : null;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6 lg:py-20">
      {/* The eyebrow carries the shield, so it is passed as the icon-bearing
          string the header already centres — this block was hand-rolled at a
          different tracking and top margin than every other page's heading. */}
      <PageHeader
        align="center"
        eyebrow="Player account"
        eyebrowIcon={ShieldCheck}
        title={
          step === "google-onboarding" ? "Choose your username"
            : upgrade ? "Save your progress"
            : modeParam === "signin" ? "Welcome back"
            : "Play chess."
        }
      />

      <Panel className="mt-6 animate-fade-in-up p-6 [animation-delay:60ms]">
        {step === "google-onboarding" ? (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Choose your username</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Pick a unique display name for ChainMate. This is how other players will see you.
              </p>
            </div>
            <div>
              <label htmlFor="onboard-username" className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Username
              </label>
              <Input
                id="onboard-username"
                autoFocus
                placeholder="GrandMaster7"
                value={username}
                maxLength={20}
                onChange={(e) => { setUsername(e.target.value.replace(/[^A-Za-z0-9_]/g, "")); setUsernameState("idle"); }}
                onKeyDown={(e) => e.key === "Enter" && !busy && void completeGoogleOnboarding()}
                className="mt-1.5"
              />
              {usernameHint && (
                <p className={cn("mt-1.5 text-2xs", usernameState === "ok" && "text-primary", usernameState === "taken" && "text-destructive", usernameState === "checking" && "text-muted-foreground")}>
                  {usernameHint}
                </p>
              )}
              <p className="mt-1 text-2xs text-muted-foreground">
                3–20 characters · letters, numbers, underscores. Your public name.
              </p>
            </div>
            <Button onClick={() => void completeGoogleOnboarding()} disabled={busy || username.trim().length < 3}>
              {busy ? "Creating account…" : "Continue"}
            </Button>
            <button
              type="button"
              onClick={() => { setStep("form"); setGoogleOnboardingToken(null); setUsername(""); setError(null); }}
              className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Back
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => void startGoogleOAuth()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2.5 rounded-md border border-border/70 bg-card px-4 py-3 text-sm font-medium text-foreground transition-all hover:bg-card/80 active:scale-[0.98] disabled:opacity-60"
            >
              <GoogleGIcon /> Continue with Google
            </button>
            <Button
              variant="ghost"
              size="lg"
              className="w-full text-muted-foreground hover:text-foreground"
              onClick={startAsGuest}
            >
              Play as Guest <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            {!configured && (
              <p className="text-center text-2xs text-muted-foreground">
                Guest play works without an account. Sign up to save your rating and history.
              </p>
            )}
          </div>
        )}

        {error && <ErrorNote message={error} className="mt-4" />}
      </Panel>

      <p className="mt-6 animate-fade-in-up text-center text-2xs text-muted-foreground [animation-delay:120ms]">
        <Link href="/" className="underline-offset-2 hover:underline">
          ← Back to ChainMate
        </Link>
      </p>
    </div>
  );
}
