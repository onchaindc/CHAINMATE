/**
 * Treasury payout dispatch — ChainMate Phase 3B.
 *
 * Drives the REAL dispatch module over deterministic fakes for the payout
 * node. The determinism proof (the crash-safety foundation) is exercised for
 * real: actual ed25519 keypairs sign twice, and the byte-identical signature
 * proves a re-broadcast produces the same transaction. Everything else —
 * WAL persistence, recovery re-broadcast with a reused vsh, expiry,
 * idempotency, on-chain verification, reconciliation — runs against the real
 * module with fake RPC seams. No live node required.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as DispatchModule from "@/lib/server/tournament-payouts-dispatch";
import type * as PayoutsModule from "@/lib/server/tournament-payouts";
import type { PayoutRecord, PayoutStore } from "@/lib/server/tournament-payouts";

let dispatch: typeof DispatchModule;
let payouts: typeof PayoutsModule;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const TREASURY = "NQ09V9Q7P4V07V0XGV0XGV0XGV0XGV0XGV0X".replace(/[^A-Z0-9]/g, "").slice(0, 36);
const WINNER = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000".replace(/\s/g, "");

/** In-memory PayoutStore mirroring the real fast-store semantics. */
function memPayoutStore(initial: PayoutRecord[] = []) {
  const rows = new Map<string, PayoutRecord>();
  for (const p of initial) rows.set(`${p.tournamentId}:${p.playerId}`, p);
  const store: PayoutStore = {
    async listByTournament(tid) {
      return [...rows.values()]
        .filter((r) => r.tournamentId === tid)
        .sort((a, b) => a.payoutRank - b.payoutRank);
    },
    async upsert(p) {
      rows.set(`${p.tournamentId}:${p.playerId}`, JSON.parse(JSON.stringify(p)));
    },
    async get(tid, pid) {
      return rows.get(`${tid}:${pid}`) ?? null;
    },
  };
  return { store, rows };
}

function plannedPayout(overrides: Partial<PayoutRecord> = {}): PayoutRecord {
  return {
    tournamentId: "tour_3b",
    playerId: "acct_w",
    payoutRank: 1,
    shareBps: 10000,
    amountLuna: "250000",
    destinationAddress: WINNER,
    status: "pending",
    payoutTxHash: null,
    sentAt: null,
    verifiedAt: null,
    failureReason: null,
    // A real dispatched payout always records its sender at write-ahead time.
    senderAddress: TREASURY,
    ...overrides,
  };
}

/** Fake payout-node RPC recorder: counts broadcasts, replays height. */
function makeNode(opts: { height?: number; failSend?: Error; unlocked?: boolean } = {}) {
  const broadcasts: Array<{
    wallet: string;
    recipient: string;
    value: bigint;
    fee: bigint;
    vsh: number;
  }> = [];
  const node = {
    height: opts.height ?? 1000,
    broadcasts,
    sendBasicTransaction: async (
      wallet: string,
      recipient: string,
      value: bigint,
      fee: bigint,
      vsh: number,
    ): Promise<string> => {
      if (opts.failSend) throw opts.failSend;
      broadcasts.push({ wallet, recipient, value, fee, vsh });
      // The real node derives the hash from the tx; the fake derives it from
      // the tx FIELDS — same determinism premise the recovery relies on.
      const fields = `${wallet}|${recipient}|${value}|${fee}|${vsh}`;
      return fakeHash(fields);
    },
    getBlockNumber: async () => opts.height ?? 1000,
    isAccountUnlocked: async () => opts.unlocked ?? true,
  };
  return node;
}

function fakeHash(seed: string): string {
  // Deterministic 64-hex "hash" from the seed (test-only).
  let h = "";
  for (let i = 0; i < 8; i++) {
    let x = 0;
    for (let j = 0; j < seed.length; j++) {
      x = (x * 31 + seed.charCodeAt(j) + i * 7) % 0xffffffff;
    }
    h += x.toString(16).padStart(8, "0");
  }
  return h.slice(0, 64);
}

function signerFrom(node: ReturnType<typeof makeNode>): PayoutsModule.TreasurySigner {
  return {
    // The fake mirrors the real RPC signer contract: broadcast with the
    // caller-pinned vsh (crash recovery reuses the recorded one).
    sendPayout: (addr, amt, vsh) => node.sendBasicTransaction(TREASURY, addr, amt, 0n, vsh ?? 1000),
    getChainHeight: () => Promise.resolve(node.height),
    getSenderAddress: () => TREASURY,
  };
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-payout-dispatch-"));
  process.chdir(root);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NIMIQ_PAYOUT_RPC_URL;
  delete process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS;
  process.env.NIMIQ_PAYOUT_CONFIRMATIONS_REQUIRED = "10";
  payouts = await import("@/lib/server/tournament-payouts");
  dispatch = await import("@/lib/server/tournament-payouts-dispatch");
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
});

/* ------------------------------------------------------------------ */
/* Determinism proof (the crash-safety foundation)                     */
/* ------------------------------------------------------------------ */

test("ed25519 is deterministic: same message+key → byte-identical signature", async () => {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2");
  if (!ed.etc.sha512Sync) ed.etc.sha512Sync = (m: Uint8Array) => sha512(m);
  if (!ed.etc.sha512Async) ed.etc.sha512Async = async (m: Uint8Array) => sha512(m);
  const priv = ed.utils.randomPrivateKey();
  const msg = new TextEncoder().encode("chainmate-payout-determinism");
  const sig1 = await ed.signAsync(msg, priv);
  const sig2 = await ed.signAsync(msg, priv);
  assert.ok(sig1.every((b, i) => b === sig2[i]), "signatures must be identical");
  assert.ok(ed.verify(sig1, msg, ed.getPublicKey(priv)), "signature verifies");
});

test("a re-broadcast with identical fields yields an identical transaction hash", async () => {
  const node = makeNode();
  const h1 = await node.sendBasicTransaction(TREASURY, WINNER, 250000n, 0n, 1000);
  const h2 = await node.sendBasicTransaction(TREASURY, WINNER, 250000n, 0n, 1000);
  assert.equal(h1, h2, "same fields → same hash (chain dedupes the duplicate)");
  assert.equal(node.broadcasts.length, 2, "both broadcasts were attempted");
  // Different vsh → different tx (why the WAL must pin the vsh).
  const h3 = await node.sendBasicTransaction(TREASURY, WINNER, 250000n, 0n, 1001);
  assert.notEqual(h1, h3);
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

test("no payout config → buildRpcTreasurySigner returns null (typed-off)", () => {
  assert.equal(dispatch.buildRpcTreasurySigner(), null);
});

test("misconfiguration (partial env) raises a typed config error", async () => {
  process.env.NIMIQ_PAYOUT_RPC_URL = "http://127.0.0.1:1";
  delete process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS;
  try {
    // Async wrapper: buildRpcTreasurySigner throws synchronously, and a sync
    // throw inside the arg expression would bypass assert.rejects' handler.
    await assert.rejects(
      async () => {
        dispatch.buildRpcTreasurySigner();
      },
      (err: unknown) =>
        err instanceof Error && /NIMIQ_PAYOUT_TREASURY_ADDRESS is missing/.test(err.message),
    );
  } finally {
    delete process.env.NIMIQ_PAYOUT_RPC_URL;
  }
});

/* ------------------------------------------------------------------ */
/* The crash-safe dispatch protocol                                    */
/* ------------------------------------------------------------------ */

test("happy path: pending → write-ahead dispatching → sent with the real hash", async () => {
  const { store, rows } = memPayoutStore([plannedPayout()]);
  const node = makeNode({ height: 900 });
  const signer = signerFrom(node);
  const sent = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer });
  assert.equal(sent.status, "sent");
  assert.match(sent.payoutTxHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(sent.validityStartHeight, 900);
  assert.equal(sent.dispatchAttempts, 1);
  // WAL row was persisted before the broadcast (write-ahead): the row now
  // carries the intent metadata it was dispatched under.
  const row = rows.get("tour_3b:acct_w");
  assert.equal(row?.senderAddress, TREASURY);
  assert.equal(row?.validityStartHeight, 900);
  assert.equal(node.broadcasts.length, 1);
  assert.equal(node.broadcasts[0].wallet, TREASURY);
  assert.equal(node.broadcasts[0].recipient, WINNER);
  assert.equal(node.broadcasts[0].value, 250000n);
  assert.equal(node.broadcasts[0].fee, 0n);
});

test("CRASH SAFETY: a 'dispatching' row is recovered by re-broadcast with the SAME vsh", async () => {
  // Simulate: write-ahead recorded, broadcast happened, process died before
  // persisting the hash (the classic lost-hash scenario).
  const crashed = plannedPayout({
    status: "dispatching",
    senderAddress: TREASURY,
    validityStartHeight: 950,
    dispatchAttempts: 1,
  });
  const { store, rows } = memPayoutStore([crashed]);
  const node = makeNode({ height: 955 });
  const signer = signerFrom(node);

  // What the original broadcast (lost) would have produced:
  const lostHash = await node.sendBasicTransaction(TREASURY, WINNER, 250000n, 0n, 950);

  const recovered = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer });
  assert.equal(recovered.status, "sent");
  assert.equal(
    recovered.payoutTxHash,
    lostHash,
    "recovery must reproduce the exact original transaction",
  );
  assert.equal(recovered.validityStartHeight, 950, "vsh is reused, never re-drawn");
  assert.equal(recovered.dispatchAttempts, 2);
  // The re-broadcast was sent with the SAME fields (the fake returns the
  // identical hash for identical fields, mirroring real Nimiq determinism).
  const last = node.broadcasts[node.broadcasts.length - 1];
  assert.equal(last.vsh, 950);
  assert.equal(last.recipient, WINNER);
  assert.equal(last.value, 250000n);
  // Durable state is the sent record now.
  assert.equal(rows.get("tour_3b:acct_w")?.status, "sent");
});

test("an expired WAL intent (vsh older than the validity window) fails safely for re-plan", async () => {
  const stale = plannedPayout({
    status: "dispatching",
    senderAddress: TREASURY,
    // height 11,000 → age 10,000 > 7,200 (the real 120×60 validity window)
    validityStartHeight: 1_000,
    dispatchAttempts: 1,
  });
  const { store } = memPayoutStore([stale]);
  const node = makeNode({ height: 11_000 });
  const signer = signerFrom(node);
  await assert.rejects(
    () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
    (err: unknown) =>
      err instanceof payouts.PayoutTransitionError &&
      err.status === 409 &&
      /expired/i.test(err.message),
  );
  // Row is marked failed (re-plan path) and NO broadcast went out.
  const row = await store.get("tour_3b", "acct_w");
  assert.equal(row?.status, "failed");
  assert.match(row?.failureReason ?? "", /expired/i);
});

test("a WAL intent inside the 7,200-block validity window still re-broadcasts (deterministic recovery)", async () => {
  // Age 7,199 blocks: still mineable under the current Nimiq policy
  // (transaction_validity_window 120 batches × 60 blocks per batch), so the
  // ONLY safe action is the deterministic re-broadcast with the recorded vsh
  // — failing it here would be premature and could orphan broadcast money.
  const stillValid = plannedPayout({
    status: "dispatching",
    senderAddress: TREASURY,
    validityStartHeight: 1_000 - 7_199, // height 1000 → age 7,199
    dispatchAttempts: 1,
  });
  const { store } = memPayoutStore([stillValid]);
  const node = makeNode({ height: 1_000 });
  const sent = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer: signerFrom(node) });
  assert.equal(sent.status, "sent");
  assert.equal(node.broadcasts.length, 1);
  // Recovery re-broadcasts with the SAME recorded vsh → byte-identical tx.
  assert.equal(node.broadcasts[0]?.vsh, 1_000 - 7_199);
});

test("the 7,200-block threshold is the exact boundary: age 7,200 re-broadcasts, 7,201 re-plans", async () => {
  // age === threshold → `age > VSH_STALENESS_BLOCKS` is false → re-broadcast.
  const boundary = plannedPayout({
    status: "dispatching",
    senderAddress: TREASURY,
    validityStartHeight: 1_000 - 7_200, // height 1000 → age 7,200
    dispatchAttempts: 1,
  });
  {
    const { store } = memPayoutStore([boundary]);
    const node = makeNode({ height: 1_000 });
    const sent = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer: signerFrom(node) });
    assert.equal(sent.status, "sent");
    assert.equal(node.broadcasts.length, 1);
  }
  // age = threshold + 1 → provably dead → typed failure for re-plan.
  const pastWindow = plannedPayout({
    status: "dispatching",
    senderAddress: TREASURY,
    validityStartHeight: 1_000 - 7_201, // height 1000 → age 7,201
    dispatchAttempts: 1,
  });
  {
    const { store } = memPayoutStore([pastWindow]);
    const node = makeNode({ height: 1_000 });
    await assert.rejects(
      () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer: signerFrom(node) }),
      (err: unknown) =>
        err instanceof payouts.PayoutTransitionError &&
        err.status === 409 &&
        /expired/i.test(err.message),
    );
    assert.equal(node.broadcasts.length, 0);
  }
});

test("incomplete WAL intent cannot be recovered — typed failure, no broadcast", async () => {
  const broken = plannedPayout({
    status: "dispatching",
    senderAddress: null,
    validityStartHeight: null,
  });
  const { store } = memPayoutStore([broken]);
  const node = makeNode({ height: 1000 });
  const signer = signerFrom(node);
  await assert.rejects(
    () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
    /Incomplete dispatch intent/,
  );
  assert.equal(node.broadcasts.length, 0);
  const row = await store.get("tour_3b", "acct_w");
  assert.equal(row?.status, "failed");
});

test("dispatching a sent payout is an idempotent no-op — never re-sent", async () => {
  const sent = plannedPayout({
    status: "sent",
    payoutTxHash: "a".repeat(64),
    sentAt: 1,
    senderAddress: TREASURY,
    validityStartHeight: 900,
    dispatchAttempts: 1,
  });
  const { store } = memPayoutStore([sent]);
  const node = makeNode({ height: 1000 });
  const signer = signerFrom(node);
  const again = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer });
  assert.equal(again.status, "sent");
  assert.equal(again.payoutTxHash, "a".repeat(64));
  assert.equal(node.broadcasts.length, 0, "no second broadcast");
});

test("dispatching a verified payout is a no-op", async () => {
  const verified = plannedPayout({
    status: "verified",
    payoutTxHash: "b".repeat(64),
    sentAt: 1,
    verifiedAt: 2,
  });
  const { store } = memPayoutStore([verified]);
  const node = makeNode();
  const signer = signerFrom(node);
  const same = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer });
  assert.equal(same.status, "verified");
  assert.equal(node.broadcasts.length, 0);
});

test("blocked_no_wallet cannot be dispatched", async () => {
  const blocked = plannedPayout({
    status: "blocked_no_wallet",
    destinationAddress: null,
    failureReason: "Winner has no linked Nimiq wallet yet",
  });
  const { store } = memPayoutStore([blocked]);
  const node = makeNode();
  const signer = signerFrom(node);
  await assert.rejects(
    () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
    (err: unknown) =>
      err instanceof payouts.PayoutTransitionError && err.status === 409 && /no linked/i.test(err.message),
  );
  assert.equal(node.broadcasts.length, 0);
});

test("unconfigured signer → typed 503, WAL state untouched", async () => {
  const { store } = memPayoutStore([plannedPayout()]);
  await assert.rejects(
    () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer: null }),
    (err: unknown) => err instanceof payouts.PayoutTransitionError && err.status === 503,
  );
  const row = await store.get("tour_3b", "acct_w");
  assert.equal(row?.status, "pending");
});

test("node unreachable → typed rpc-unavailable; WAL intent persists for recovery", async () => {
  const { store, rows } = memPayoutStore([plannedPayout()]);
  const node = makeNode({ height: 900 });
  void node;
  // The node answers reads (WAL planning works) but the BROADCAST transport
  // is down — the realistic outage shape. The write-ahead intent persists.
  const failingSigner: PayoutsModule.TreasurySigner = {
    sendPayout: () => Promise.reject(new Error("connect ECONNREFUSED")),
    getChainHeight: () => Promise.resolve(900),
    getSenderAddress: () => TREASURY,
  };
  await assert.rejects(
    () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer: failingSigner }),
    (err: unknown) =>
      err instanceof dispatch.PayoutDispatchError &&
      (err.kind === "broadcast-failed" || err.kind === "rpc-unavailable"),
  );
  // The write-ahead intent remains — recovery will re-broadcast same vsh.
  const row = rows.get("tour_3b:acct_w");
  assert.equal(row?.status, "dispatching");
  assert.equal(row?.validityStartHeight, 900);
});

test("broadcast failure after WAL → row stays dispatching (recovery-ready)", async () => {
  const { store, rows } = memPayoutStore([plannedPayout()]);
  const node = makeNode({ height: 900, failSend: new Error("mempool rejected: insufficient funds") });
  const signer = signerFrom(node);
  await assert.rejects(
    () => dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
    /insufficient funds/,
  );
  assert.equal(rows.get("tour_3b:acct_w")?.status, "dispatching");
  assert.equal(node.broadcasts.length, 0);
});

test("locked treasury wallet → typed wallet-locked error", async () => {
  // Through the real signer builder: unlock check fires before any broadcast.
  // The H4 guard compares the payout treasury against the entry treasury, so
  // both must agree here (other suites set NIMIQ_TREASURY_ADDRESS process-wide).
  process.env.NIMIQ_PAYOUT_RPC_URL = "http://127.0.0.1:1";
  process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS = TREASURY;
  process.env.NIMIQ_TREASURY_ADDRESS = TREASURY;
  try {
    const signer = dispatch.buildRpcTreasurySigner({
      sendBasicTransaction: async () => "a".repeat(64),
      getBlockNumber: async () => 1000,
      isAccountUnlocked: async () => false,
    });
    assert.ok(signer);
    await assert.rejects(
      () => signer!.sendPayout(WINNER, 1n),
      (err: unknown) =>
        err instanceof dispatch.PayoutDispatchError && err.kind === "wallet-locked",
    );
  } finally {
    delete process.env.NIMIQ_PAYOUT_RPC_URL;
    delete process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS;
  }
});

test("concurrent dispatch attempts serialize — exactly one broadcast", async () => {
  const { store } = memPayoutStore([plannedPayout()]);
  const node = makeNode({ height: 900 });
  const signer = signerFrom(node);
  const [a, b, c] = await Promise.allSettled([
    dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
    dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
    dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer }),
  ]);
  const fulfilled = [a, b, c].filter(
    (r): r is PromiseFulfilledResult<PayoutRecord> => r.status === "fulfilled",
  );
  // All resolve (idempotency), but only ONE broadcast happened.
  assert.ok(fulfilled.length >= 1);
  assert.equal(node.broadcasts.length, 1, `expected 1 broadcast, got ${node.broadcasts.length}`);
  const sent = await store.get("tour_3b", "acct_w");
  assert.equal(sent?.status, "sent");
  assert.equal(sent?.dispatchAttempts, 1);
});

test("large luna amounts dispatch exactly (no float drift)", async () => {
  const big = plannedPayout({ amountLuna: "9007199254740993" }); // > 2^53
  const { store } = memPayoutStore([big]);
  const node = makeNode({ height: 900 });
  const signer = signerFrom(node);
  const sent = await dispatch.dispatchPayout("tour_3b", "acct_w", { store, signer });
  assert.equal(sent.status, "sent");
  assert.equal(node.broadcasts[0].value, 9007199254740993n);
});

/* ------------------------------------------------------------------ */
/* Real on-chain verification of an outgoing payout                    */
/* ------------------------------------------------------------------ */

function makeVerifyDeps(opts: {
  payout: PayoutRecord;
  store: PayoutStore;
  onChainTx?: Partial<{
    hash: string;
    from: string;
    to: string;
    value: string;
    blockNumber: number | null;
    executionResult: boolean;
  }> | null;
  height?: number;
  confirmationsRequired?: number;
}) {
  return {
    store: opts.store,
    confirmationsRequired: opts.confirmationsRequired ?? 10,
    getTransactionByHash: (async () => {
      if (opts.onChainTx === null) return null;
      return {
        hash: opts.payout.payoutTxHash ?? "a".repeat(64),
        from: TREASURY,
        to: opts.payout.destinationAddress ?? WINNER,
        value: opts.payout.amountLuna,
        blockNumber: 991,
        executionResult: true,
        networkId: 5,
        ...(opts.onChainTx ?? {}),
      };
    }) as unknown as typeof import("@/lib/server/nimiq/rpc").getTransactionByHash,
    getBlockNumber: (async () => opts.height ?? 1000) as unknown as typeof import("@/lib/server/nimiq/rpc").getBlockNumber,
  };
}

test("verification marks VERIFIED when the on-chain tx matches exactly", async () => {
  const sent = plannedPayout({
    status: "sent",
    payoutTxHash: "c".repeat(64),
    sentAt: 1,
  });
  const { store } = memPayoutStore([sent]);
  const verified = await dispatch.verifyOutgoingPayout(
    "tour_3b",
    "acct_w",
    makeVerifyDeps({ payout: sent, store, height: 1000 }), // 991 → 10 conf
  );
  assert.equal(verified.status, "verified");
  assert.ok(verified.verifiedAt);
});

test("verification boundary: 9 confirmations → not yet; 10 → verified", async () => {
  const sent = plannedPayout({ status: "sent", payoutTxHash: "d".repeat(64), sentAt: 1 });
  const { store } = memPayoutStore([sent]);
  await assert.rejects(
    () =>
      dispatch.verifyOutgoingPayout(
        "tour_3b",
        "acct_w",
        makeVerifyDeps({ payout: sent, store, height: 1000, confirmationsRequired: 11 }),
      ),
    (err: unknown) =>
      err instanceof dispatch.PayoutDispatchError &&
      err.kind === "reconciliation-required" &&
      /10 confirmations, 11 required/.test(err.message),
  );
  const ok = await dispatch.verifyOutgoingPayout(
    "tour_3b",
    "acct_w",
    makeVerifyDeps({ payout: sent, store, height: 1001, confirmationsRequired: 11 }), // 991→11
  );
  assert.equal(ok.status, "verified");
});

test("verification rejects a wrong recipient / wrong value / failed execution", async () => {
  for (const bad of [
    { to: "NQ11" + "0".repeat(32) }, // wrong recipient
    { value: "1" }, // wrong value
    { executionResult: false }, // failed execution
  ]) {
    const sent = plannedPayout({ status: "sent", payoutTxHash: "e".repeat(64), sentAt: 1 });
    const { store } = memPayoutStore([sent]);
    await assert.rejects(
      () =>
        dispatch.verifyOutgoingPayout(
          "tour_3b",
          "acct_w",
          makeVerifyDeps({ payout: sent, store, height: 1000, onChainTx: bad }),
        ),
      (err: unknown) => err instanceof dispatch.PayoutDispatchError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
    const row = await store.get("tour_3b", "acct_w");
    assert.equal(row?.status, "sent", "a failed verification must NOT mark verified");
  }
});

test("verification of a wrong-sender tx is rejected", async () => {
  const sent = plannedPayout({ status: "sent", payoutTxHash: "f".repeat(64), sentAt: 1 });
  const { store } = memPayoutStore([sent]);
  await assert.rejects(
    () =>
      dispatch.verifyOutgoingPayout(
        "tour_3b",
        "acct_w",
        makeVerifyDeps({
          payout: sent,
          store,
          height: 1000,
          onChainTx: { from: WINNER }, // not the treasury
        }),
      ),
    (err: unknown) => err instanceof dispatch.PayoutDispatchError,
  );
});

test("an unmined payout is not verifiable yet (reconciliation-required)", async () => {
  const sent = plannedPayout({ status: "sent", payoutTxHash: "1".repeat(64), sentAt: 1 });
  const { store } = memPayoutStore([sent]);
  await assert.rejects(
    () =>
      dispatch.verifyOutgoingPayout(
        "tour_3b",
        "acct_w",
        makeVerifyDeps({ payout: sent, store, height: 1000, onChainTx: { blockNumber: null } }),
      ),
    (err: unknown) =>
      err instanceof dispatch.PayoutDispatchError &&
      err.kind === "reconciliation-required" &&
      /not yet included/i.test(err.message),
  );
});

test("a sent payout can never be verified without a real hash", async () => {
  const noHash = plannedPayout({ status: "sent", payoutTxHash: null, sentAt: 1 });
  const { store } = memPayoutStore([noHash]);
  await assert.rejects(
    () => dispatch.verifyOutgoingPayout("tour_3b", "acct_w", makeVerifyDeps({ payout: noHash, store })),
    /real transaction hash/,
  );
});

/* ------------------------------------------------------------------ */
/* Reconciliation sweep                                                */
/* ------------------------------------------------------------------ */

test("reconcileDispatchingPayouts recovers mid-flight rows deterministically", async () => {
  const crashed = plannedPayout({
    status: "dispatching",
    senderAddress: TREASURY,
    validityStartHeight: 990,
    dispatchAttempts: 1,
  });
  const waiting = plannedPayout({
    playerId: "acct_x",
    payoutRank: 2,
    status: "pending",
    amountLuna: "100000",
  });
  const { store } = memPayoutStore([crashed, waiting]);
  const node = makeNode({ height: 995 });
  const signer = signerFrom(node);
  const result = await dispatch.reconcileDispatchingPayouts("tour_3b", { store, signer });
  assert.equal(result.reconciled, 1);
  assert.equal(result.pending, 1);
  const recovered = await store.get("tour_3b", "acct_w");
  assert.equal(recovered?.status, "sent");
  assert.equal(recovered?.validityStartHeight, 990);
});

test("reconciliation requires a signer (typed 503 without one)", async () => {
  const { store } = memPayoutStore([plannedPayout()]);
  await assert.rejects(
    () => dispatch.reconcileDispatchingPayouts("tour_3b", { store, signer: null }),
    (err: unknown) => err instanceof payouts.PayoutTransitionError && err.status === 503,
  );
});
