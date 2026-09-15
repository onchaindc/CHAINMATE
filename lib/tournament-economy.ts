/**
 * Tournament economy — ChainMate Phase 2B (client-safe, pure).
 *
 * Distribution presets and exact luna arithmetic for prize pools and
 * payouts. NOTHING here touches floats: percentages are basis points and
 * every allocation is computed with BigInt integer math. The same pool and
 * preset always produce the same allocation — deterministic by construction.
 *
 * Rounding rules (documented, deterministic):
 *   • each rank's share = floor(pool × share_bps / 10000) in luna
 *   • rounding dust (the luna lost to floors) is accumulated explicitly and
 *     reported so it can be kept accounted for rather than silently lost
 *   • allocations never exceed the pool: sum(allocations) ≤ pool always
 *
 * Presets (exact, from the brief):
 *   winner: 100%
 *   top3:   60 / 25 / 15
 *   top5:   45 / 25 / 15 / 10 / 5
 */

import { LUNA_PER_NIM } from "@/lib/nimiq/format";

export type PrizePreset = "winner" | "top3" | "top5";

export const PRIZE_PRESETS: PrizePreset[] = ["winner", "top3", "top5"];

export function isPrizePreset(v: unknown): v is PrizePreset {
  return typeof v === "string" && (PRIZE_PRESETS as string[]).includes(v);
}

/** Share per rank (1-based) in basis points. 10000 bps = 100%. */
export const PRESET_SHARES_BPS: Record<PrizePreset, number[]> = {
  winner: [10_000],
  top3: [6_000, 2_500, 1_500],
  top5: [4_500, 2_500, 1_500, 1_000, 500],
};

export function presetRankCount(preset: PrizePreset): number {
  return PRESET_SHARES_BPS[preset].length;
}

export function presetLabel(preset: PrizePreset): string {
  return PRESET_SHARES_BPS[preset]
    .map((bps) => `${bps / 100}%`)
    .join(" / ");
}

/** Exact share for one rank from a pool — floor division, never rounds up. */
export function shareOfRank(poolLuna: bigint, shareBps: number): bigint {
  return (poolLuna * BigInt(shareBps)) / 10_000n;
}

export interface PrizeAllocation {
  /** 1-based final-standings rank. */
  rank: number;
  shareBps: number;
  amountLuna: bigint;
}

export interface PrizeAllocationResult {
  allocations: PrizeAllocation[];
  /** Sum of all rank allocations. */
  allocatedLuna: bigint;
  /** pool − allocated: explicit dust kept accounted for, never silently lost. */
  dustLuna: bigint;
}

/**
 * Allocate a prize pool across the first N ranks of a preset.
 * Deterministic, integer-only, and total ≤ pool always.
 */
export function allocatePrizePool(
  poolLuna: bigint,
  preset: PrizePreset,
): PrizeAllocationResult {
  if (poolLuna < 0n) {
    throw new Error("Prize pool cannot be negative");
  }
  const shares = PRESET_SHARES_BPS[preset];
  const allocations: PrizeAllocation[] = [];
  for (let i = 0; i < shares.length; i++) {
    const amount = shareOfRank(poolLuna, shares[i]);
    allocations.push({ rank: i + 1, shareBps: shares[i], amountLuna: amount });
  }
  const allocated = allocations.reduce((acc, a) => acc + a.amountLuna, 0n);
  if (allocated > poolLuna) {
    // Cannot happen with floor division — kept as a hard invariant check.
    throw new Error("Payout allocation would exceed the prize pool");
  }
  return { allocations, allocatedLuna: allocated, dustLuna: poolLuna - allocated };
}

/* ------------------------------------------------------------------ */
/* Entry fee handling                                                  */
/* ------------------------------------------------------------------ */

/** Parse a digits-only luna string (the durable storage format) to bigint. */
export function lunaFromStored(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Stored luna value is malformed: ${value}`);
  }
  return BigInt(value);
}

/** Parse a client-supplied NIM string into exact luna, rejecting nonsense. */
export function parseEntryFeeNim(input: string): bigint {
  // Strict human format: optional whole part, optional fraction ≤ 5 places.
  const match = /^(\d+)(?:\.(\d{1,5}))?$/.exec(input.trim());
  if (!match) {
    throw new Error(
      'Entry fee must be a NIM amount with at most 5 decimals, like "5" or "1.25"',
    );
  }
  const whole = BigInt(match[1]);
  const fracPadded = (match[2] ?? "").padEnd(5, "0");
  return whole * LUNA_PER_NIM + BigInt(fracPadded === "" ? "0" : fracPadded);
}

/** A paid tournament needs a strictly positive exact fee. */
export function validateEntryFee(feeLuna: bigint): string | null {
  if (feeLuna <= 0n) {
    return "entryFeeNim must be greater than 0 for a paid tournament";
  }
  return null;
}

/** True when this stored fee makes a tournament PAID (fee > 0). */
export function isPaidEntryFee(feeLuna: bigint | null | undefined): boolean {
  return feeLuna !== null && feeLuna !== undefined && feeLuna > 0n;
}
