/**
 * Nimiq integration configuration — Phase 1A foundation.
 *
 * Client-safe module (mirrors lib/config.ts conventions): NEXT_PUBLIC_* vars
 * are inlined at build time. Server-only values (the RPC endpoint and its
 * credentials) are read lazily through getServerNimiqRpcConfig() so importing
 * this module from client code never bakes secrets into the bundle — in a
 * browser, process.env values that Next does not inline are simply undefined.
 *
 * Networks (fixed ids from the Nimiq protocol):
 *  - "main"  → networkId 42 (Main Albatross)
 *  - "test"  → networkId 5  (TestAlbatross / testnet)
 *
 * Env vars:
 *  NEXT_PUBLIC_NIMIQ_ENABLED        "true" turns the Nimiq UI on
 *  NEXT_PUBLIC_NIMIQ_NETWORK        "main" | "test" | "testnet" (alias)
 *  NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS  NQ… address (unused until 2B; declared now)
 *  NIMIQ_RPC_URL                    server-side JSON-RPC endpoint (no public default)
 *  NIMIQ_RPC_BASIC_AUTH             optional "user:password" for HTTP Basic auth
 *  NIMIQ_CONFIRMATIONS_REQUIRED     confirmations before a tx counts (default 10)
 */

export type NimiqNetworkName = "main" | "test";
export type NimiqNetworkId = 42 | 5;

/** Protocol network ids — fixed constants, not guesses. */
export const NIMIQ_NETWORK_IDS: Record<NimiqNetworkName, NimiqNetworkId> = {
  main: 42,
  test: 5,
};

/** Resolve a configured network name (accepts "testnet" as an alias for "test"). */
export function nimiqNetworkName(value: string | undefined): NimiqNetworkName {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "main" || v === "mainnet") return "main";
  // Default to test: a missing/mistyped value must never point money code at
  // mainnet by accident.
  return "test";
}

export function nimiqNetworkId(name: NimiqNetworkName): NimiqNetworkId {
  return NIMIQ_NETWORK_IDS[name];
}

/** Feature flag — everything Nimiq in the UI keys off this.
 *  Delegated to lib/nimiq/flag.ts so there is exactly one reader. */
import { isNimiqEnabled } from "@/lib/nimiq/flag";
export const NIMIQ_ENABLED: boolean = isNimiqEnabled();

export const NIMIQ_NETWORK: NimiqNetworkName = nimiqNetworkName(
  process.env.NEXT_PUBLIC_NIMIQ_NETWORK,
);

export const NIMIQ_NETWORK_ID: NimiqNetworkId = nimiqNetworkId(NIMIQ_NETWORK);

/**
 * Treasury address reserved for Phase 2B (entry fees/payouts). Declared and
 * validated here so 2B only reads config; Phase 1A never uses it.
 */
export const NIMIQ_TREASURY_ADDRESS: string =
  (process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS ?? "").trim();

/** Loose NQ-address shape check (grouped or ungrouped, 36 base32 chars). */
export function isPlausibleNimiqAddress(address: string): boolean {
  const compact = address.replace(/[\s-]/g, "").toUpperCase();
  return /^NQ[0-9A-Z]{34}$/.test(compact);
}

export interface NimiqServerRpcConfig {
  url: string;
  /** "user:password" for HTTP Basic auth, or null. */
  basicAuth: string | null;
  /** Confirmations required before a transaction is treated as settled. */
  confirmationsRequired: number;
}

/**
 * Server-only RPC configuration. Returns null when no RPC URL is configured —
 * there is deliberately NO public endpoint default (requirement 9): the
 * operator must point ChainMate at their own node.
 */
export function getServerNimiqRpcConfig(): NimiqServerRpcConfig | null {
  const url = (process.env.NIMIQ_RPC_URL ?? "").trim();
  if (!url) return null;
  const auth = (process.env.NIMIQ_RPC_BASIC_AUTH ?? "").trim();
  const parsed = Number.parseInt(process.env.NIMIQ_CONFIRMATIONS_REQUIRED ?? "", 10);
  return {
    url,
    basicAuth: auth || null,
    confirmationsRequired:
      Number.isFinite(parsed) && parsed >= 1 ? parsed : 10,
  };
}
