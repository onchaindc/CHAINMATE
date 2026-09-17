/**
 * Durable record of a tournament entry payment that has been SENT on-chain
 * but is not yet credited — ChainMate Phase 2B double-payment fix.
 *
 * The moment a wallet returns a transaction hash, money has left the player
 * and that hash is THE payment for this flow. Everything that happens after
 * (the confirmation window, a reload, a tab crash, a closed tab) must never
 * lose it: the server never saw the transaction, so client persistence is
 * the only thing standing between a refresh and a second charge.
 *
 * Storage: localStorage (survives reloads, tab closes, and browser restarts —
 * sessionStorage died on the second of those, which is how payments were
 * orphaned before this). Keyed per tournament AND player, with a 24h expiry
 * so stale entries never haunt a tournament forever.
 *
 * Client-safe module: plain localStorage access, no server imports.
 */

const KEY_PREFIX = "chainmate:pending-entry-tx:";
/** A payment older than this is treated as abandoned; the UI can dismiss it. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredPendingTx {
  txHash: string;
  /** Epoch ms when the send was confirmed by the wallet. */
  at: number;
}

function storageKey(tournamentId: string, playerId: string): string {
  return `${KEY_PREFIX}${tournamentId}:${playerId}`;
}

/**
 * Record the payment for `tournamentId` + `playerId`. Called the instant the
 * wallet returns a hash — BEFORE any verification is attempted.
 */
export function savePendingEntryTx(tournamentId: string, playerId: string, txHash: string): void {
  if (typeof localStorage === "undefined" || !tournamentId || !playerId || !txHash) return;
  try {
    const record: StoredPendingTx = { txHash: txHash.trim().toLowerCase(), at: Date.now() };
    localStorage.setItem(storageKey(tournamentId, playerId), JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode, quota) — in-memory recovery still
    // covers the common case; nothing else we can do from here.
  }
}

/**
 * The saved hash for this player + tournament, or null. Expired entries are
 * pruned on read — they can no longer be trusted as "the" payment because
 * the player has very likely been credited or refunded through support.
 */
export function loadPendingEntryTx(tournamentId: string, playerId: string): string | null {
  if (typeof localStorage === "undefined" || !tournamentId || !playerId) return null;
  try {
    const raw = localStorage.getItem(storageKey(tournamentId, playerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPendingTx>;
    if (typeof parsed?.txHash !== "string" || typeof parsed?.at !== "number") {
      localStorage.removeItem(storageKey(tournamentId, playerId));
      return null;
    }
    if (Date.now() - parsed.at > MAX_AGE_MS) {
      localStorage.removeItem(storageKey(tournamentId, playerId));
      return null;
    }
    return parsed.txHash;
  } catch {
    return null;
  }
}

/** The payment verified (seat credited) or was explicitly dismissed. */
export function clearPendingEntryTx(tournamentId: string, playerId: string): void {
  if (typeof localStorage === "undefined" || !tournamentId || !playerId) return;
  try {
    localStorage.removeItem(storageKey(tournamentId, playerId));
  } catch {
    // best-effort
  }
}
