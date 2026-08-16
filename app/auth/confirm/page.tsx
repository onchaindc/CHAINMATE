"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Supabase's default magic-link emails point at `{SiteURL}/auth/confirm`
 * (with the token as a query param or a `#token_hash=` fragment). This page
 * exists purely to forward that to /auth, where the app verifies the token
 * and finishes the sign-in / guest-upgrade flow.
 */
function ConfirmRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const queryHash = params.get("token_hash");
    const queryType = params.get("type") ?? "email";

    // Newer Supabase versions deliver the token as a URL hash fragment
    // (#token_hash=…) — normalise both forms into query params.
    let fragmentToken: string | null = null;
    let fragmentType: string | null = null;
    const raw = window.location.hash.replace(/^#/, "");
    if (raw) {
      const hashParams = new URLSearchParams(raw);
      fragmentToken = hashParams.get("token_hash");
      fragmentType = hashParams.get("type");
    }

    const tokenHash = queryHash ?? fragmentToken;
    const type = queryType ?? fragmentType ?? "email";

    if (tokenHash) {
      const q = new URLSearchParams({ token_hash: tokenHash, type });
      router.replace(`/auth?${q.toString()}`);
    } else {
      router.replace("/auth");
    }
  }, [params, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <span className="h-8 w-8 animate-pulse rounded-full bg-secondary/60" aria-hidden />
    </div>
  );
}

export default function AuthConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmRedirect />
    </Suspense>
  );
}
