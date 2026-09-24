/**
 * Durable record of a pool top-up that has been SENT on-chain but is not yet
 * credited to a tournament's prize pool — the admin-console twin of
 * `pending-entry-tx.ts` (Phase 2B double-payment fix).
 *
 * The moment the wallet returns a transaction hash, money has LEFT the
 * operator's wallet and that hash is THE top-up. Everything after (the
 * confirmation window, a reload, a closed tab) must never lose it: the
 * server has not consumed the transaction yet, so client persistence is the
 * only thing standing between a refresh and a SECOND payment.
 *
 * Storage: localStorage, keyed per tournament (the console is single-admin,
 * so the key does not need the player id), with a 24h expiry.
 *
 * Client-safe module: plain localStorage access, no server imports.
 */

const KEY_PREFIX = "chainmate:pending-topup-tx:";
/** A top-up older than this is treated as abandoned; the UI can dismiss it. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredPendingTopUp {
  txHash: string;
  /** Epoch ms when the send was confirmed by the wallet. */
  at: number;
}

function storageKey(tournamentId: string): string {
  return `${KEY_PREFIX}${tournamentId}`;
}

/**
 * Record the top-up for `tournamentId`. Called the instant the wallet
 * returns a hash — BEFORE any claim is attempted.
 */
export function savePendingTopUpTx(tournamentId: string, txHash: string): void {
  if (typeof localStorage === "undefined" || !tournamentId || !txHash) return;
  try {
    const record: StoredPendingTopUp = { txHash: txHash.trim().toLowerCase(), at: Date.now() };
    localStorage.setItem(storageKey(tournamentId), JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode, quota) — in-memory recovery still
    // covers the common case; nothing else we can do from here.
  }
}

/**
 * The saved hash for this tournament, or null. Expired entries are pruned
 * on read.
 */
export function loadPendingTopUpTx(tournamentId: string): string | null {
  if (typeof localStorage === "undefined" || !tournamentId) return null;
  try {
    const raw = localStorage.getItem(storageKey(tournamentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPendingTopUp>;
    if (typeof parsed?.txHash !== "string" || typeof parsed?.at !== "number") {
      localStorage.removeItem(storageKey(tournamentId));
      return null;
    }
    if (Date.now() - parsed.at > MAX_AGE_MS) {
      localStorage.removeItem(storageKey(tournamentId));
      return null;
    }
    return parsed.txHash;
  } catch {
    return null;
  }
}

/** The top-up was credited (or explicitly dismissed) — stop tracking it. */
export function clearPendingTopUpTx(tournamentId: string): void {
  if (typeof localStorage === "undefined" || !tournamentId) return;
  try {
    localStorage.removeItem(storageKey(tournamentId));
  } catch {
    // best-effort
  }
}
