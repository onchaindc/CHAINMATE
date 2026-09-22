/**
 * Prize-pool top-ups + distribution re-planning — the admin console's money
 * controls, driven through the REAL Phase 1C verification engine.
 *
 * Covers the operator story end to end:
 *   1. top-up prepare — amount validation, cancelled-tournament refusal,
 *      missing-treasury refusal, and the wire facts (treasury + exact luna);
 *   2. top-up claim — the verified on-chain transaction credits the pool
 *      (kind='pool_topup'), sender attribution through the real gates,
 *      admin-only claiming, replay protection (one hash, one credit), and
 *      the pool actually growing in getVerifiedPrizePool();
 *   3. distribution re-planning — the purse can be re-cut as top 1 / top 3 /
 *      top 5 while NOTHING is dispatched, and never after money moved;
 *      stale ranks disappear when the shape shrinks.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as TopUpModule from "@/lib/server/tournament-topup";
import type * as PayoutsModule from "@/lib/server/tournament-payouts";
import type * as EconomyModule from "@/lib/server/tournament-economy";
import type * as TxModule from "@/lib/server/nimiq/transactions";

let topup: typeof TopUpModule;
let payouts: typeof PayoutsModule;
let economy: typeof EconomyModule;
let tx: typeof TxModule;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const ADMIN_WALLET = "NQ0700000000000000000000000000000000";
const TREASURY = "NQ09V9Q7P4V07V0XGV0XGV0XGV0XGV0XGV0X".replace(/[^A-Z0-9]/g, "").slice(0, 36);

/** The engine's fake tournament doc — only the fields the top-up reads. */
interface FakeDoc {
  id: string;
  status: string;
  creatorId: string;
}

let seq = 0;

function validTx(over: Partial<{ value: string; to: string; from: string; executionResult: boolean }> = {}) {
  seq += 1;
  return {
    hash: `c${seq.toString().padStart(63, "0")}`,
    from: ADMIN_WALLET,
    to: TREASURY,
    value: "2500000", // 25 NIM
    blockNumber: 990,
    executionResult: true,
    networkId: 5,
    ...over,
  };
}

/** In-memory consumption store — the durable replay guard in miniature. */
function makeTxStore() {
  const consumed = new Map<string, TxModule.VerifiedNimiqTransaction>();
  return {
    async findByNetworkAndHash(network: string, txHash: string) {
      return consumed.get(`${network}:${txHash}`) ?? null;
    },
    async insertConsumed(row: Omit<TxModule.VerifiedNimiqTransaction, "id" | "verifiedAt">) {
      const key = `${row.network}:${row.txHash}`;
      if (consumed.has(key)) {
        throw new tx.NimiqTxError("already-consumed", "This transaction was already consumed");
      }
      const id = consumed.size + 1;
      consumed.set(key, { ...row, id, verifiedAt: Date.now() });
      return id;
    },
    async listByTournament(tournamentId: string) {
      return [...consumed.values()].filter((r) => r.tournamentId === tournamentId);
    },
  };
}

/** In-memory payout store with the same shape as fastStorePayoutStore. */
function makePayoutStore() {
  const rows = new Map<string, PayoutsModule.PayoutRecord>();
  const key = (t: string, p: string) => `${t}:${p}`;
  return {
    async listByTournament(tournamentId: string) {
      return [...rows.values()]
        .filter((r) => r.tournamentId === tournamentId)
        .sort((a, b) => a.payoutRank - b.payoutRank);
    },
    async upsert(payout: PayoutsModule.PayoutRecord) {
      rows.set(key(payout.tournamentId, payout.playerId), payout);
    },
    async get(tournamentId: string, playerId: string) {
      return rows.get(key(tournamentId, playerId)) ?? null;
    },
    async remove(tournamentId: string, playerId: string) {
      rows.delete(key(tournamentId, playerId));
    },
  };
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-topup-"));
  process.chdir(root);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NIMIQ_RPC_URL = "http://127.0.0.1:1";
  process.env.NIMIQ_CONFIRMATIONS_REQUIRED = "10";
  // Hermetic: a real server-side treasury from .env.local must not leak in.
  delete process.env.NIMIQ_TREASURY_ADDRESS;
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = TREASURY;
  process.env.NEXT_PUBLIC_NIMIQ_NETWORK = "test";
  tx = await import("@/lib/server/nimiq/transactions");
  economy = await import("@/lib/server/tournament-economy");
  payouts = await import("@/lib/server/tournament-payouts");
  topup = await import("@/lib/server/tournament-topup");

  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
});

/** The fake engine doc the top-up module reads through its seam. */
const fakeDoc = (over: Partial<FakeDoc> = {}): FakeDoc => ({
  id: "tour_topup",
  status: "registration",
  creatorId: "acct_host",
  ...over,
});

/** Deps fakes: doc seam + admin gate (only acct_admin passes) + treasury. */
const depsFor = (over: Partial<FakeDoc> = {}): TopUpModule.TopUpDeps => ({
  getDoc: (async () => fakeDoc(over)) as unknown as TopUpModule.TopUpDeps["getDoc"],
  isAdmin: async (pid: string) => pid === "acct_admin",
  getTreasuryAddress: () => TREASURY,
});

/**
 * Claim through the REAL verification engine with a fake RPC + linked
 * wallet: the same shape of call claimTopUp makes, with every seam faked
 * except the money logic under test.
 */
function verifyWith(
  txStore: ReturnType<typeof makeTxStore>,
  rpcTx: ReturnType<typeof validTx>,
  obligationOver: { kind?: string; txHash?: string } = {},
) {
  return tx.verifyIncomingTransaction(
    rpcTx.hash,
    {
      playerId: "acct_admin",
      kind: "pool_topup",
      tournamentId: "tour_topup",
      network: "test",
      ...obligationOver,
    } as Parameters<typeof tx.verifyIncomingTransaction>[1],
    {
      store: txStore,
      rpc: {
        getTransactionByHash: async () => rpcTx,
        getBlockNumber: async () => 1000,
      },
      getLinkedWallet: async () => ({ address: ADMIN_WALLET, network: "test" as const, linkedAt: 0 }),
    },
  );
}

const HOST_RANKS = [
  { rank: 1, playerId: "acct_w1" },
  { rank: 2, playerId: "acct_w2" },
  { rank: 3, playerId: "acct_w3" },
  { rank: 4, playerId: "acct_w4" },
  { rank: 5, playerId: "acct_w5" },
];

function assertPlan(
  result: PayoutsModule.PayoutPlanResult | { skipped: string },
): asserts result is PayoutsModule.PayoutPlanResult {
  assert(!("skipped" in result), `payout planning skipped: ${"skipped" in result ? result.skipped : ""}`);
}

/* ------------------------------------------------------------------ */
/* Prepare                                                             */
/* ------------------------------------------------------------------ */

test("prepare: valid amount returns treasury + exact luna wire facts", async () => {
  const intent = await topup.prepareTopUp("tour_topup", "25", depsFor());
  assert.equal(intent.recipientAddress, TREASURY);
  assert.equal(intent.amountLuna, "2500000");
  assert.equal(intent.network, "test");
});

test("prepare: fractional amounts parse exactly (no float dust)", async () => {
  const intent = await topup.prepareTopUp("tour_topup", "2.5", depsFor());
  assert.equal(intent.amountLuna, "250000");
  const tiny = await topup.prepareTopUp("tour_topup", "0.00001", depsFor());
  assert.equal(tiny.amountLuna, "1");
});

test("prepare: zero, negative and nonsense amounts refused", async () => {
  await assert.rejects(() => topup.prepareTopUp("tour_topup", "0", depsFor()), /more than zero/);
  // parseNim accepts a leading minus (it returns negative luna) — the
  // positivity gate is what actually refuses it.
  await assert.rejects(() => topup.prepareTopUp("tour_topup", "-5", depsFor()), /more than zero/);
  await assert.rejects(() => topup.prepareTopUp("tour_topup", "abc", depsFor()), /NIM amount/);
  await assert.rejects(() => topup.prepareTopUp("tour_topup", "1.000001", depsFor()), /NIM amount/);
  await assert.rejects(() => topup.prepareTopUp("tour_topup", "", depsFor()), /NIM amount/);
});

test("prepare: cancelled tournaments refuse new money", async () => {
  await assert.rejects(() => topup.prepareTopUp("tour_topup", "5", depsFor({ status: "cancelled" })), /cancelled/);
});

/* ------------------------------------------------------------------ */
/* Claim — through the REAL verification engine                        */
/* ------------------------------------------------------------------ */

test("claim: the verified tx credits the pool and the pool grows", async () => {
  const txStore = makeTxStore();
  const rpcTx = validTx();
  // Seed one paid entry (5 NIM) so the pool has a base.
  await txStore.insertConsumed({
    network: "test",
    txHash: `e${"0".repeat(63)}`,
    playerId: "acct_p1",
    kind: "tournament_entry",
    tournamentId: "tour_topup",
    sender: ADMIN_WALLET,
    recipient: TREASURY,
    amountLuna: "500000",
    blockNumber: 1,
    confirmations: 99,
  });
  const before = await economy.getVerifiedPrizePool("tour_topup", txStore);
  assert.equal(before, 500_000n);

  // Drive the real engine: the same call claimTopUp makes internally, with
  // the fake RPC + admin payer, to prove kind='pool_topup' verification and
  // pool accounting work together.
  const verified = await tx.verifyIncomingTransaction(
    rpcTx.hash,
    { playerId: "acct_admin", kind: "pool_topup", tournamentId: "tour_topup", network: "test" },
    {
      store: txStore,
      rpc: {
        getTransactionByHash: async () => rpcTx,
        getBlockNumber: async () => 1000,
      },
      getLinkedWallet: async () => ({ address: ADMIN_WALLET, network: "test" as const, linkedAt: 0 }),
    },
  );
  assert.equal(verified.kind, "pool_topup");
  assert.equal(verified.amountLuna, "2500000");
  assert.equal(verified.tournamentId, "tour_topup");

  const after = await economy.getVerifiedPrizePool("tour_topup", txStore);
  assert.equal(after, 3_000_000n, "pool = entries + top-up");
});

test("claim path: refunds and plain verifications never count toward the pool", async () => {
  const txStore = makeTxStore();
  await txStore.insertConsumed({
    network: "test",
    txHash: `f${"1".repeat(63)}`,
    playerId: "acct_admin",
    kind: "refund",
    tournamentId: "tour_topup",
    sender: ADMIN_WALLET,
    recipient: TREASURY,
    amountLuna: "500000",
    blockNumber: 1,
    confirmations: 99,
  });
  await txStore.insertConsumed({
    network: "test",
    txHash: `f${"2".repeat(63)}`,
    playerId: "acct_admin",
    kind: "verification",
    tournamentId: "tour_topup",
    sender: ADMIN_WALLET,
    recipient: TREASURY,
    amountLuna: "900000",
    blockNumber: 1,
    confirmations: 99,
  });
  assert.equal(await economy.getVerifiedPrizePool("tour_topup", txStore), 0n);
});

test("replay: the same top-up hash can never credit the pool twice", async () => {
  const txStore = makeTxStore();
  const rpcTx = validTx();
  const deps = {
    store: txStore,
    rpc: {
      getTransactionByHash: async () => rpcTx,
      getBlockNumber: async () => 1000,
    },
    getLinkedWallet: async () => ({ address: ADMIN_WALLET, network: "test" as const, linkedAt: 0 }),
  };
  const obligation = {
    playerId: "acct_admin",
    kind: "pool_topup" as const,
    tournamentId: "tour_topup",
    network: "test" as const,
  };
  await tx.verifyIncomingTransaction(rpcTx.hash, obligation, deps);
  await assert.rejects(
    () => tx.verifyIncomingTransaction(rpcTx.hash, obligation, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "already-consumed",
  );
  assert.equal(await economy.getVerifiedPrizePool("tour_topup", txStore), 2_500_000n);
});

test("claim: a non-treasury recipient is refused outright", async () => {
  const txStore = makeTxStore();
  const rpcTx = validTx({ to: "NQ99NOTTREASURYYYYYYYYYYYYYYYYYYYYYYY" });
  await assert.rejects(
    () =>
      tx.verifyIncomingTransaction(
        rpcTx.hash,
        { playerId: "acct_admin", kind: "pool_topup", tournamentId: "tour_topup", network: "test" },
        {
          store: txStore,
          rpc: { getTransactionByHash: async () => rpcTx, getBlockNumber: async () => 1000 },
          getLinkedWallet: async () => ({ address: ADMIN_WALLET, network: "test" as const, linkedAt: 0 }),
        },
      ),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-recipient",
  );
  assert.equal(await economy.getVerifiedPrizePool("tour_topup", txStore), 0n);
});

test("claim: a sender that is not the admin's linked wallet is refused", async () => {
  const txStore = makeTxStore();
  const rpcTx = validTx({ from: "NQ99NOTADMINNNNNNNNNNNNNNNNNNNNNNNNN" });
  await assert.rejects(
    () =>
      tx.verifyIncomingTransaction(
        rpcTx.hash,
        { playerId: "acct_admin", kind: "pool_topup", tournamentId: "tour_topup", network: "test" },
        {
          store: txStore,
          rpc: { getTransactionByHash: async () => rpcTx, getBlockNumber: async () => 1000 },
          getLinkedWallet: async () => ({ address: ADMIN_WALLET, network: "test" as const, linkedAt: 0 }),
        },
      ),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-sender",
  );
});

test("claimTopUp: non-admin callers are refused before any chain read", async () => {
  const txStore = makeTxStore();
  await assert.rejects(
    () =>
      topup.claimTopUp("tour_topup", "acct_random", `d${"0".repeat(63)}`, {
        ...depsFor(),
        store: txStore,
      }),
    (err: unknown) => err instanceof topup.TopUpError && err.kind === "not-admin",
  );
});

test("claimTopUp: an admin claim runs the real engine and credits the pool", async () => {
  const txStore = makeTxStore();
  const rpcTx = validTx();
  // Seed a 5 NIM entry so the pool has a base.
  await txStore.insertConsumed({
    network: "test",
    txHash: `e${"9".repeat(63)}`,
    playerId: "acct_p1",
    kind: "tournament_entry",
    tournamentId: "tour_topup",
    sender: ADMIN_WALLET,
    recipient: TREASURY,
    amountLuna: "500000",
    blockNumber: 1,
    confirmations: 99,
  });
  const result = await topup.claimTopUp("tour_topup", "acct_admin", rpcTx.hash, {
    ...depsFor(),
    store: txStore,
    verify: (async (hash: string) => verifyWith(txStore, rpcTx, { txHash: hash })) as never,
  });
  assert.equal(result.amountLuna, "2500000");
  assert.equal(BigInt(result.poolLunaAfter), 3_000_000n);
});

/* ------------------------------------------------------------------ */
/* Distribution re-planning                                            */
/* ------------------------------------------------------------------ */

test("re-plan: top3 → top5 with nothing dispatched rebuilds the purse", async () => {
  const store = makePayoutStore();
  const pool = 2_500_000n; // 25 NIM
  const first = await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top3", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  assertPlan(first);
  assert.equal(first.created, 3);

  const second = await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top5", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  assertPlan(second);
  const rows = await store.listByTournament("tour_topup");
  assert.equal(rows.length, 5, "the purse now has five ranks");
  assert.deepEqual(
    rows.map((r) => r.shareBps),
    [4_500, 2_500, 1_500, 1_000, 500],
  );
  const total = rows.reduce((acc, r) => acc + BigInt(r.amountLuna), 0n);
  assert.ok(total <= pool);
});

test("re-plan: top5 → top3 removes the ghost ranks entirely", async () => {
  const store = makePayoutStore();
  const pool = 2_500_000n;
  await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top5", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  const re = await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top3", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  assertPlan(re);
  const rows = await store.listByTournament("tour_topup");
  assert.equal(rows.length, 3);
  assert.ok(!rows.some((r) => r.payoutRank === 4 || r.payoutRank === 5));
});

test("re-plan: same preset is an idempotent no-op, not a rebuild", async () => {
  const store = makePayoutStore();
  const pool = 2_500_000n;
  await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top3", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  const again = await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top3", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  assertPlan(again);
  assert.equal(again.created, 0);
  const rows = await store.listByTournament("tour_topup");
  assert.equal(rows.length, 3);
});

test("re-plan: refused once any prize has been dispatched", async () => {
  const store = makePayoutStore();
  const pool = 2_500_000n;
  await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "top3", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => ({ address: "NQ_W1", network: "test" as const, linkedAt: 0 }) },
  );
  // Rank 1 gets paid out.
  const rank1 = await store.get("tour_topup", "acct_w1");
  assert.ok(rank1);
  await store.upsert({ ...rank1!, status: "sent", payoutTxHash: "a".repeat(64), sentAt: 1 });

  const refused = await payouts.planTournamentPayouts(
    "tour_topup",
    { preset: "winner", standingsRanks: HOST_RANKS },
    { store, getPrizePool: async () => pool, getWallet: async () => null },
  );
  assertPlan(refused);
  assert.equal(refused.created, 0, "existing rows returned untouched");
  const rows = await store.listByTournament("tour_topup");
  assert.equal(rows.length, 3, "the dispatched plan is immutable");
  assert.deepEqual(
    rows.map((r) => r.shareBps),
    [6_000, 2_500, 1_500],
  );
});
