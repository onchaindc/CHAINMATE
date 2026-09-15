// Server-only module — never import from client components.

/**
 * Paid-entry state on the tournament document — ChainMate Phase 2B.
 *
 * Kept as a tiny separate module so both the Phase 2A engine
 * (lib/server/tournaments.ts) and the economy service can share the exact
 * document shape without either importing the other's heavier graph.
 */

/** Phase 2B fields added to the Phase 2A tournament document. */
export interface EconomyFields {
  /** EXACT entry fee in luna, digits-only text. null/absent = free tournament. */
  entryFeeLuna: string | null;
  /** Prize distribution preset, only meaningful for paid tournaments. */
  prizePreset: "winner" | "top3" | "top5" | null;
}

/** Paid-entry record carried on one TournamentEntry. */
export interface PaidEntryState {
  /** Verified transaction hash (lowercase hex) that paid this entry. */
  txHash: string;
  /** Unix ms the payment was verified by the server. */
  paidAt: number;
}

/**
 * Read the economy fields off a document tolerantly (older documents created
 * before 2B simply lack the fields).
 */
export function economyFieldsOf(doc: {
  entryFeeLuna?: string | null;
  prizePreset?: EconomyFields["prizePreset"];
}): EconomyFields {
  return {
    entryFeeLuna: doc.entryFeeLuna ?? null,
    prizePreset: doc.prizePreset ?? null,
  };
}

/** Is this tournament a paid one (positive exact fee)? */
export function isPaidTournamentDoc(doc: {
  entryFeeLuna?: string | null;
}): boolean {
  const fee = doc.entryFeeLuna ?? null;
  return fee !== null && /^\d+$/.test(fee) && BigInt(fee) > 0n;
}

/**
 * Mark a player's entry as paid on the document, mutating in place. The
 * caller must already hold the tournament document lock and must persist
 * the document afterwards.
 */
export function markEntryPaid(
  doc: { entries: Array<{ playerId: string; leftAt?: number; paid?: PaidEntryState }> },
  playerId: string,
  txHash: string,
): void {
  const entry = doc.entries.find((e) => e.playerId === playerId);
  if (!entry) return;
  entry.paid = { txHash: txHash.toLowerCase(), paidAt: Date.now() };
}
