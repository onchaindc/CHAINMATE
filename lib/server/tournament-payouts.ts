// Server-only module — never import from client components.

/**
 * Tournament payouts — ChainMate Phase 2B.
 *
 * When a PAID tournament completes, the engine computes final standings with
 * the existing Phase 2A deterministic engine and this module turns the
 * verified prize pool into durable payout records:
 *
 *   • pool = sum of verified kind='tournament_entry' consumptions (never a
 *     client/config number)
 *   • shares from the tournament's preset, exact integer luna, floor
 *     division; rounding dust is kept explicitly on the tournament (see
 *     dust_luna below — it is never silently lost and never overpaid)
 *   • destinations are the players' Phase 1B verified wallet bindings — a
 *     winner with no linked wallet lands in a durable BLOCKED_NO_WALLET
 *     state with the reason surfaced, never an invented address
 *   • execution is behind an explicit seam: ChainMate has NO custodial
 *     treasury signer, so payouts stay PENDING until a real signer is
 *     configured. Payout execution without a signer raises a typed
 *     configuration error. Payout tx hashes are never faked.
 *
 * STATE MACHINE (durable, per payout row):
 *   PENDING ──signer configured + send succeeds──▶ SENT ──verify──▶ VERIFIED
 *      │
 *      └── winner has no linked wallet ──▶ BLOCKED_NO_WALLET (awaiting link)
 *   FAILED is a retryable terminal-adjacent state (host can retry → PENDING).
 *
 * The tournament-level aggregate lives on the tournament row:
 *   payout_status: none → pending → partial → paid (or refund_required)
 */

import {
  allocatePrizePool,
  isPrizePreset,
  type PrizePreset,
} from "@/lib/tournament-economy";
import { getLinkedWallet } from "@/lib/server/nimiq/service";
import { getGameStorage } from "@/lib/server/storage";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PayoutStatus =
  | "pending"
  | "dispatching"
  | "sent"
  | "verified"
  | "failed"
  | "blocked_no_wallet";

export interface PayoutRecord {
  tournamentId: string;
  playerId: string;
  /** 1-based final-standings rank. */
  payoutRank: number;
  shareBps: number;
  /** Exact luna, digits-only string (durable format). */
  amountLuna: string;
  /** Phase-1B verified destination; null while blocked_no_wallet. */
  destinationAddress: string | null;
  status: PayoutStatus;
  /** Real outgoing treasury tx hash; null until a signer exists. Never faked. */
  payoutTxHash: string | null;
  sentAt: number | null;
  verifiedAt: number | null;
  failureReason: string | null;
  /* --- Phase 3B dispatch metadata (all optional for 2B-created rows) --- */
  /** Chain the payout dispatch ran on. */
  network?: "main" | "test";
  /** Treasury address the payout node signs from. */
  senderAddress?: string | null;
  /** WRITE-AHEAD: recorded BEFORE broadcast; reused on every recovery. */
  validityStartHeight?: number | null;
  /** How many broadcast attempts have been made. */
  dispatchAttempts?: number;
  /** When the most recent broadcast attempt went out. */
  lastBroadcastAt?: number | null;
}

/** Result of building payouts at completion. */
export interface PayoutPlanResult {
  created: number;
  prizePoolLuna: bigint;
  allocatedLuna: bigint;
  dustLuna: bigint;
  payouts: PayoutRecord[];
}

/* ------------------------------------------------------------------ */
/* Storage — durable payout ledger (project storage + Supabase mirror) */
/* ------------------------------------------------------------------ */

interface PayoutsFile {
  payouts: Record<string, PayoutRecord>;
}

/* ------------------------------------------------------------------ */
/* M4 — monotonic payout persistence                                   */
/* ------------------------------------------------------------------ */

export const PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "pending",
  "dispatching",
  "sent",
  "verified",
  "failed",
  "blocked_no_wallet",
];

export function isPayoutStatus(value: string): value is PayoutStatus {
  return (PAYOUT_STATUSES as readonly string[]).includes(value);
}

/**
 * Persistence rank of a payout status. Higher = more advanced. pending,
 * failed and blocked_no_wallet share the lowest rank: they are all
 * retryable starting points (a failed/blocked payout legitimately returns
 * to pending via retryPayout).
 */
export function payoutStatusRank(status: PayoutStatus): number {
  switch (status) {
    case "dispatching": return 2;
    case "sent": return 3;
    case "verified": return 4;
    default: return 1; // pending | failed | blocked_no_wallet
  }
}

/**
 * M4 — a stale write must NEVER move a payout backward. The more advanced
 * of the two records wins outright: a pending/failed/blocked write arriving
 * after the payout was dispatched (sent/verified) is dropped, and a stale
 * pending write cannot clobber an in-flight WAL ('dispatching') row either.
 * Forward transitions (including retry re-planning) are untouched.
 *
 * Explicit backward exception: 'dispatching' → 'failed' is the WAL
 * RESOLUTION path (expired/incomplete dispatch intent) — it must stay
 * possible or a dead WAL row could never be cleared for re-planning.
 * Equal-rank rewrites are allowed (pending ↔ failed ↔ blocked_no_wallet
 * are all pre-dispatch retryable states; retryPayout uses failed → pending).
 */
const BACKWARD_ALLOWED: ReadonlySet<string> = new Set(["dispatching>failed"]);

export function mergeMonotonicPayout(existing: PayoutRecord, incoming: PayoutRecord): PayoutRecord {
  const rankIn = payoutStatusRank(incoming.status);
  const rankEx = payoutStatusRank(existing.status);
  if (rankIn < rankEx && !BACKWARD_ALLOWED.has(`${existing.status}>${incoming.status}`)) {
    return existing;
  }
  return incoming;
}

/**
 * B2 — the payout ledger lives in the SAME project storage abstraction as
 * every other ChainMate store (KV when configured, else the .data file
 * store) under its own key. It no longer touches the filesystem directly,
 * so payout state follows the deployment's storage backend.
 */
const PAYOUTS_KEY = "chainmate:payouts";

async function readPayoutsFile(): Promise<PayoutsFile> {
  try {
    const raw = await getGameStorage().get(PAYOUTS_KEY);
    if (!raw) return { payouts: {} };
    const parsed = JSON.parse(raw) as PayoutsFile;
    return parsed?.payouts ? parsed : { payouts: {} };
  } catch {
    return { payouts: {} };
  }
}

async function writePayoutsFile(file: PayoutsFile): Promise<void> {
  await getGameStorage().set(PAYOUTS_KEY, JSON.stringify(file));
}

/**
 * One-time import of payouts written by the pre-B2 raw-file store
 * (.data/payouts.json). Merge-then-persist so no pre-existing payout state
 * is lost when the deployment upgrades. Safe to call repeatedly (the legacy
 * file simply stops existing as a source once imported or absent).
 */
export async function migrateLegacyPayoutStore(): Promise<number> {
  const { readFileSafe } = await import("@/lib/server/legacy-store");
  const raw = readFileSafe("payouts.json");
  if (!raw) return 0;
  let legacy: PayoutsFile;
  try {
    legacy = JSON.parse(raw) as PayoutsFile;
  } catch {
    return 0;
  }
  if (!legacy?.payouts) return 0;
  const current = await readPayoutsFile();
  let imported = 0;
  for (const [key, payout] of Object.entries(legacy.payouts)) {
    const existing = current.payouts[key];
    current.payouts[key] = existing ? mergeMonotonicPayout(existing, payout) : payout;
    if (!existing) imported += 1;
  }
  await writePayoutsFile(current);
  return imported;
}

function payoutKey(tournamentId: string, playerId: string): string {
  return `${tournamentId}:${playerId}`;
}

/** Process-wide lock so concurrent completions cannot double-create payouts. */
const payoutLocks = new Map<string, Promise<unknown>>();

export async function withPayoutLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = payoutLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  payoutLocks.set(key, run.catch(() => undefined));
  return run;
}

/** Storage seam — fakes in tests replace this. */
export interface PayoutStore {
  listByTournament(tournamentId: string): Promise<PayoutRecord[]>;
  upsert(payout: PayoutRecord): Promise<void>;
  get(tournamentId: string, playerId: string): Promise<PayoutRecord | null>;
}

export const fastStorePayoutStore: PayoutStore = {
  async listByTournament(tournamentId) {
    const file = await readPayoutsFile();
    return Object.values(file.payouts)
      .filter((p) => p.tournamentId === tournamentId)
      .sort((a, b) => a.payoutRank - b.payoutRank);
  },
  async upsert(payout) {
    await withPayoutLock(`row:${payout.tournamentId}:${payout.playerId}`, async () => {
      const file = await readPayoutsFile();
      const key = payoutKey(payout.tournamentId, payout.playerId);
      const existing = file.payouts[key];
      // M4: never persist a backward transition over a more advanced state.
      file.payouts[key] = existing ? mergeMonotonicPayout(existing, payout) : payout;
      await writePayoutsFile(file);
    });
  },
  async get(tournamentId, playerId) {
    const file = await readPayoutsFile();
    return file.payouts[payoutKey(tournamentId, playerId)] ?? null;
  },
};

/* ------------------------------------------------------------------ */
/* Planning & creation (at tournament completion)                      */
/* ------------------------------------------------------------------ */

export interface PlanPayoutsDeps {
  store?: PayoutStore;
  /** Prize-pool reader (defaults to the verified ledger). */
  getPrizePool?: (tournamentId: string) => Promise<bigint>;
  /** Wallet lookup (defaults to the Phase 1B service). */
  getWallet?: typeof getLinkedWallet;
}

/**
 * Create the payout records for a completed PAID tournament.
 *
 * Idempotent: if payout rows already exist for the tournament (completion
 * racing, or a re-run), the existing rows are returned untouched — a
 * tournament is never paid twice.
 */
export async function planTournamentPayouts(
  tournamentId: string,
  input: {
    preset: string | null;
    standingsRanks: Array<{ rank: number; playerId: string }>;
  },
  deps: PlanPayoutsDeps = {},
): Promise<PayoutPlanResult | { skipped: "not-paid" | "no-preset" | "empty-pool" }> {
  const store = deps.store ?? fastStorePayoutStore;

  return withPayoutLock(`plan:${tournamentId}`, async () => {
    // Idempotency guard.
    const existing = await store.listByTournament(tournamentId);
    if (existing.length > 0) {
      const pool = existing.reduce((acc, p) => acc + BigInt(p.amountLuna), 0n);
      return {
        created: 0,
        prizePoolLuna: pool,
        allocatedLuna: pool,
        dustLuna: 0n,
        payouts: existing,
      };
    }

    if (!isPrizePreset(input.preset)) {
      return { skipped: "no-preset" };
    }
    const preset: PrizePreset = input.preset;

    const getPool =
      deps.getPrizePool ??
      (async (id: string) => {
        const { getVerifiedPrizePool } = await import("@/lib/server/tournament-economy");
        return getVerifiedPrizePool(id);
      });
    const pool = await getPool(tournamentId);
    if (pool <= 0n) {
      return { skipped: "empty-pool" };
    }

    // Exact integer allocation: floor shares + explicit dust.
    const allocation: PrizeAllocationResultAlias =
      allocatePrizePool(pool, preset);

    const getWalletFn = deps.getWallet ?? getLinkedWallet;
    const payouts: PayoutRecord[] = [];
    for (const alloc of allocation.allocations) {
      const rankRow = input.standingsRanks.find((r) => r.rank === alloc.rank);
      if (!rankRow) continue; // field smaller than the preset — rank unpaid
      const wallet = await getWalletFn(rankRow.playerId).catch(() => null);
      payouts.push({
        tournamentId,
        playerId: rankRow.playerId,
        payoutRank: alloc.rank,
        shareBps: alloc.shareBps,
        amountLuna: alloc.amountLuna.toString(),
        destinationAddress: wallet?.address ?? null,
        status: wallet ? "pending" : "blocked_no_wallet",
        payoutTxHash: null,
        sentAt: null,
        verifiedAt: null,
        failureReason: wallet ? null : "Winner has no linked Nimiq wallet yet",
      });
    }

    for (const p of payouts) {
      await store.upsert(p);
    }
    await mirrorPayouts(tournamentId, payouts);

    return {
      created: payouts.length,
      prizePoolLuna: pool,
      allocatedLuna: allocation.allocatedLuna,
      dustLuna: allocation.dustLuna,
      payouts,
    };
  });
}

/** Local alias so the type stays readable. */
type PrizeAllocationResultAlias = ReturnType<typeof allocatePrizePool>;

/** Payouts for the UI (detail page). Safe to call for any tournament. */
export async function listTournamentPayouts(
  tournamentId: string,
  store: PayoutStore = fastStorePayoutStore,
): Promise<PayoutRecord[]> {
  return store.listByTournament(tournamentId);
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export class PayoutTransitionError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "PayoutTransitionError";
    this.status = status;
  }
}

/** Signer availability — Phase 2B ships with NO custodial signer. */
export interface TreasurySigner {
  /**
   * Send exactly `amountLuna` from the treasury to `address`. Returns the
   * REAL tx hash. When `validityStartHeight` is provided the signer MUST
   * broadcast with it (crash recovery re-broadcasts the recorded vsh so the
   * transaction — and therefore its hash — is byte-identical to the original).
   */
  sendPayout(address: string, amountLuna: bigint, validityStartHeight?: number): Promise<string>;
  /** Current chain height of the signer's node (write-ahead planning). */
  getChainHeight?(): Promise<number>;
  /** The address this signer signs from (write-ahead metadata). */
  getSenderAddress?(): string | null;
}

let configuredSigner: TreasurySigner | null = null;

/** Install a real treasury signer (operations concern — none ships in 2B). */
export function configureTreasurySigner(signer: TreasurySigner | null): void {
  configuredSigner = signer;
}

/**
 * Try to send one payout. Typed configuration error when no real signer is
 * configured — the brief forbids inventing one or faking hashes.
 */
export async function sendPayout(
  tournamentId: string,
  playerId: string,
  deps: { store?: PayoutStore; signer?: TreasurySigner | null } = {},
): Promise<PayoutRecord> {
  const store = deps.store ?? fastStorePayoutStore;
  return withPayoutLock(`send:${tournamentId}:${playerId}`, async () => {
    const payout = await store.get(tournamentId, playerId);
    if (!payout) throw new PayoutTransitionError("Payout record not found", 404);
    if (payout.status === "sent" || payout.status === "verified") {
      return payout; // idempotent — already dispatched
    }
    if (payout.status === "blocked_no_wallet") {
      throw new PayoutTransitionError(
        "Winner has no linked Nimiq wallet, they must link one first",
        409,
      );
    }

    const signer = deps.signer !== undefined ? deps.signer : configuredSigner;
    if (!signer) {
      throw new PayoutTransitionError(
        "No treasury signer is configured, payouts are recorded but not dispatched",
        503,
      );
    }
    if (!payout.destinationAddress) {
      throw new PayoutTransitionError("Payout has no destination address", 409);
    }

    try {
      const txHash = await signer.sendPayout(
        payout.destinationAddress,
        BigInt(payout.amountLuna),
      );
      if (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error("Signer returned no usable transaction hash");
      }
      const sent: PayoutRecord = {
        ...payout,
        status: "sent",
        payoutTxHash: txHash,
        sentAt: Date.now(),
        failureReason: null,
      };
      await store.upsert(sent);
      await mirrorPayouts(tournamentId, [sent]);
      return sent;
    } catch (err) {
      const failed: PayoutRecord = {
        ...payout,
        status: "failed",
        failureReason:
          err instanceof Error ? err.message : "Payout sending failed",
      };
      await store.upsert(failed);
      await mirrorPayouts(tournamentId, [failed]);
      return failed;
    }
  });
}

/**
 * Mark a SENT payout as VERIFIED after its on-chain transaction is
 * independently confirmed (operations concern — verification against the
 * configured Nimiq RPC happens in the caller, never invented here).
 */
export async function verifyPayout(
  tournamentId: string,
  playerId: string,
  deps: { store?: PayoutStore } = {},
): Promise<PayoutRecord> {
  const store = deps.store ?? fastStorePayoutStore;
  return withPayoutLock(`send:${tournamentId}:${playerId}`, async () => {
    const payout = await store.get(tournamentId, playerId);
    if (!payout) throw new PayoutTransitionError("Payout record not found", 404);
    if (payout.status === "verified") return payout;
    if (payout.status !== "sent" || !payout.payoutTxHash) {
      throw new PayoutTransitionError(
        "Only a sent payout with a real transaction hash can be verified",
        409,
      );
    }
    const verified: PayoutRecord = {
      ...payout,
      status: "verified",
      verifiedAt: Date.now(),
    };
    await store.upsert(verified);
    await mirrorPayouts(tournamentId, [verified]);
    return verified;
  });
}

/** Retry a FAILED payout: back to pending for the next dispatch attempt. */
export async function retryPayout(
  tournamentId: string,
  playerId: string,
  deps: { store?: PayoutStore } = {},
): Promise<PayoutRecord> {
  const store = deps.store ?? fastStorePayoutStore;
  return withPayoutLock(`send:${tournamentId}:${playerId}`, async () => {
    const payout = await store.get(tournamentId, playerId);
    if (!payout) throw new PayoutTransitionError("Payout record not found", 404);
    if (payout.status !== "failed" && payout.status !== "blocked_no_wallet") {
      throw new PayoutTransitionError("Only a failed or blocked payout can be retried", 409);
    }
    const wallet = await getLinkedWallet(playerId).catch(() => null);
    if (!wallet) {
      throw new PayoutTransitionError("Winner still has no linked Nimiq wallet", 409);
    }
    const retried: PayoutRecord = {
      ...payout,
      status: "pending",
      destinationAddress: wallet.address,
      failureReason: null,
    };
    await store.upsert(retried);
    await mirrorPayouts(tournamentId, [retried]);
    return retried;
  });
}

/**
 * Aggregate payout status for the tournament row (mirror + UI).
 *   paid    = every payout verified on-chain
 *   partial = some dispatched (sent/verified), others still outstanding
 *   pending = recorded and owed, nothing dispatched yet
 */
export function aggregatePayoutStatus(payouts: PayoutRecord[]): {
  status: "none" | "pending" | "partial" | "paid" | "refund_required";
} {
  if (payouts.length === 0) return { status: "none" };
  if (payouts.every((p) => p.status === "verified")) return { status: "paid" };
  if (payouts.some((p) => p.status === "sent" || p.status === "verified")) {
    return { status: "partial" };
  }
  return { status: "pending" };
}

/* ------------------------------------------------------------------ */
/* Durable mirror (best-effort, like every ChainMate store)            */
/* ------------------------------------------------------------------ */

export async function mirrorPayouts(tournamentId: string, payouts: PayoutRecord[]): Promise<void> {
  try {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const { supabaseConfigured } = await import("@/lib/supabase/config");
    if (!supabaseConfigured()) return;
    const admin = getSupabaseAdmin();
    if (!admin) return;
    // M4: the durable mirror is monotonic too — merge each incoming row
    // against the current durable row so an out-of-order mirror write can
    // never downgrade an advanced state (verified → sent → …) in Supabase.
    const ids = payouts.map((p) => p.playerId);
    const { data: durableRows } = await admin
      .from("tournament_payouts")
      .select("player_id, status")
      .eq("tournament_id", tournamentId)
      .in("player_id", ids.length > 0 ? ids : ["__none__"]);
    const durableStatus = new Map<string, string>();
    for (const row of (durableRows ?? []) as Array<{ player_id: string; status: string }>) {
      durableStatus.set(row.player_id, row.status);
    }
    const merged = payouts.map((p) => {
      const durable = durableStatus.get(p.playerId);
      if (durable && isPayoutStatus(durable)) {
        return mergeMonotonicPayout({ ...p, status: durable }, p);
      }
      return p;
    });
    const rows = merged.map((p) => ({
      tournament_id: p.tournamentId,
      player_id: p.playerId,
      payout_rank: p.payoutRank,
      share_bps: p.shareBps,
      amount_luna: p.amountLuna,
      destination_address: p.destinationAddress,
      status: p.status,
      payout_tx_hash: p.payoutTxHash,
      sent_at: p.sentAt ? new Date(p.sentAt).toISOString() : null,
      verified_at: p.verifiedAt ? new Date(p.verifiedAt).toISOString() : null,
      failure_reason: p.failureReason,
      network: p.network ?? null,
      sender_address: p.senderAddress ?? null,
      validity_start_height: p.validityStartHeight ?? null,
      dispatch_attempts: p.dispatchAttempts ?? 0,
      last_broadcast_at: p.lastBroadcastAt ? new Date(p.lastBroadcastAt).toISOString() : null,
    }));
    const { error } = await admin
      .from("tournament_payouts")
      .upsert(rows, { onConflict: "tournament_id,player_id" });
    if (error) {
      console.error(`[payouts] durable mirror failed (${tournamentId}): ${error.message}`);
    }
  } catch (err) {
    console.error(
      `[payouts] mirror error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
