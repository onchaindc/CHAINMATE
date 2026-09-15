// Server-only module — never import from client components.

/**
 * Payout-node configuration — ChainMate Phase 3B.
 *
 * The treasury signer talks to a DEDICATED payout node whose keystore holds
 * the treasury hot key (Phase 3A architecture decision). Its endpoint and
 * credentials are server-only secrets and are deliberately NOT exposed
 * through any NEXT_PUBLIC_* variable — nothing in the browser ever learns
 * that a signer exists, let alone where it lives.
 *
 * Env vars (all server-side):
 *   NIMIQ_PAYOUT_RPC_URL                 JSON-RPC endpoint of the payout node
 *   NIMIQ_PAYOUT_RPC_BASIC_AUTH          optional "user:password" (HTTP Basic)
 *   NIMIQ_PAYOUT_TREASURY_ADDRESS        the address whose key the node holds
 *   NIMIQ_PAYOUT_CONFIRMATIONS_REQUIRED  confirmations to mark VERIFIED (default 10)
 *
 * Missing configuration is a typed, expected state (the 2B default): the
 * signer simply does not exist and every payout seam reports a typed error.
 * Misconfiguration (e.g. an implausible treasury address) is also typed.
 */

export interface NimiqPayoutConfig {
  url: string;
  basicAuth: string | null;
  /** The address the payout node's keystore signs from. */
  treasuryAddress: string;
  /** Confirmations required before an outgoing payout counts as settled. */
  confirmationsRequired: number;
}

export class NimiqPayoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimiqPayoutConfigError";
  }
}

/**
 * Resolve the payout-node configuration, or null when payout dispatch is
 * not configured (an expected, typed-off state — not an error).
 */
export function getNimiqPayoutConfig(): NimiqPayoutConfig | null {
  const url = (process.env.NIMIQ_PAYOUT_RPC_URL ?? "").trim();
  const treasuryAddress = (process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
  if (!url && !treasuryAddress) return null; // deliberately unconfigured

  if (!url) {
    throw new NimiqPayoutConfigError(
      "NIMIQ_PAYOUT_TREASURY_ADDRESS is set but NIMIQ_PAYOUT_RPC_URL is missing",
    );
  }
  if (!treasuryAddress) {
    throw new NimiqPayoutConfigError(
      "NIMIQ_PAYOUT_RPC_URL is set but NIMIQ_PAYOUT_TREASURY_ADDRESS is missing",
    );
  }
  if (!/^NQ[0-9A-Z]{34}$/.test(treasuryAddress)) {
    throw new NimiqPayoutConfigError(
      "NIMIQ_PAYOUT_TREASURY_ADDRESS is not a plausible NQ… address",
    );
  }

  const auth = (process.env.NIMIQ_PAYOUT_RPC_BASIC_AUTH ?? "").trim();
  const parsed = Number.parseInt(process.env.NIMIQ_PAYOUT_CONFIRMATIONS_REQUIRED ?? "", 10);
  return {
    url,
    basicAuth: auth || null,
    treasuryAddress,
    confirmationsRequired: Number.isFinite(parsed) && parsed >= 1 ? parsed : 10,
  };
}
