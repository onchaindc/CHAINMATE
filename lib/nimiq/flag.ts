/**
 * Runtime Nimiq feature flag.
 *
 * Small indirection so tests (plain Node) and the client hook can both ask
 * "is Nimiq enabled?" without Next.js build-time inlining surprises: the flag
 * is read at call time from process.env, exactly like lib/config.ts does, but
 * through a function so a test can flip it by mutating process.env.
 *
 * Semantics: ENABLED unless explicitly disabled. A deployment that simply
 * never sets NEXT_PUBLIC_NIMIQ_ENABLED (the common case — production
 * configures only the server-side money variables) must still show the
 * "Connect Nimiq Wallet" UI; a wallet nobody can see is a wallet nobody can
 * link. Only an explicit opt-out ("false" / "0" / "off" / "no") turns the
 * integration off. Money-path code remains fail-closed independently — this
 * flag gates UI visibility only, never verification or payouts.
 */

const DISABLED_VALUES = new Set(["false", "0", "off", "no"]);

export function isNimiqEnabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_NIMIQ_ENABLED ?? "").trim().toLowerCase();
  return !DISABLED_VALUES.has(v);
}
