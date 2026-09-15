/**
 * Runtime Nimiq feature flag.
 *
 * Small indirection so tests (plain Node) and the client hook can both ask
 * "is Nimiq enabled?" without Next.js build-time inlining surprises: the flag
 * is read at call time from process.env, exactly like lib/config.ts does, but
 * through a function so a test can flip it by mutating process.env.
 */

export function isNimiqEnabled(): boolean {
  return process.env.NEXT_PUBLIC_NIMIQ_ENABLED === "true";
}
