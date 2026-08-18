"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useIdentity } from "@/lib/identity-context";

/**
 * Wraps protected pages. Behaviour:
 *  - loading → renders nothing (avoids flash)
 *  - guest → redirect to /auth?returnTo=<current>
 *  - authenticated but no username (incomplete onboarding) → redirect to /auth?returnTo=<current>
 *  - authenticated with complete profile → render children
 */
export function RequireProfile({ children }: { children: React.ReactNode }) {
  const identity = useIdentity();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (identity.status === "loading") return;

    // Guest: not signed in at all
    if (identity.isGuest) {
      router.replace(`/auth?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }

    // Signed in but no username (incomplete Google onboarding)
    if (!identity.username || identity.username.trim().length === 0) {
      router.replace(`/auth?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }
  }, [identity.status, identity.isGuest, identity.username, router, pathname]);

  // Still loading — render nothing to avoid flash
  if (identity.status === "loading") return null;

  // Guest or incomplete profile — render nothing while redirect happens
  if (identity.isGuest) return null;

  // Signed in but no username — render nothing while redirect happens
  if (!identity.username || identity.username.trim().length === 0) return null;

  // All checks passed — render the protected content
  return <>{children}</>;
}
