/**
 * Onboarding hardening — adversarial + stress tests for the money path.
 *
 * Everything here drives the REAL locks, REAL stores (fast project storage in
 * a scratch cwd) and REAL engine writers; only the Nimiq node RPC and the
 * wallet/profile lookups are faked — the same discipline as
 * tournament-economy.test.ts. What is pinned:
 *
 *   STRESS  a full paid field joins concurrently: exactly maxPlayers seats,
 *           every extra joiner rejected, no extra consumption rows
 *   STRESS  one player racing N different payments: exactly one seat + one
 *           consumption
 *   STRESS  concurrent dispatch of the same payout: exactly one broadcast
 *   ADVERSARIAL  the same tx hash raced across two tournaments/players:
 *           exactly one consumption; the loser's reserved seat is released
 *   ADVERSARIAL  wrong amount / wrong recipient / guest payment: rejected
 *           with NO consumption and NO seat
 *   ADVERSARIAL  WAL crash recovery: same-vsh re-broadcast is idempotent,
 *           expired intents fail closed without broadcasting
 *   SCHEMA  migrations stay scoped: durable uniqueness + monotonicity
 *   CONFIG  the network default fails closed to testnet
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as EconomyModule from "@/lib/server/tournament-economy";
import type * as DispatchModule from "@/lib/server/tournament-payouts-dispatch";
import type * as StoreModule from "@/lib/server/tournament-store";
import type * as PayoutsModule from "@/lib/server/tournament-payouts";
import { nimiqNetworkName } from "@/lib/nimiq/config";

let economy: typeof EconomyModule;
let dispatch: typeof DispatchModule;
let store: typeof StoreModule;
let payouts: typeof PayoutsModule;

/**
 * Absolute migration dir, resolved from THIS file's location — never from
 * process.cwd(), which other test files mutate via process.chdir(tmpdir)
 * while node:test runs files concurrently.
 */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../supabase/migrations",
);

const TREASURY = "NQ09V9Q7P4V07V0XGV0XGV0XGV0XGV0XGV0X".replace(/[^A-Z0-9]/g, "").slice(0, 36);
const FEE_LUNA = 500_000n; // 5 NIM
let seq = 0;

/** Deterministic per-player "linked wallet" (36-char shape, unique). */
function walletFor(n: number): string {
  return `NQAA${String(n).padStart(2, "0")}${"0".repeat(30)}`;
}

function nextHash(): string {
  seq += 1;
  return `a${seq.toString(16).padStart(63, "0")}`;
}

/** A valid on-chain tx paying the fee from `from` to the treasury. */
function validTx(from: string, overrides: Record<string, unknown> = {}) {
  return {
    hash: nextHash(),
    from,
    to: TREASURY,
    value: FEE_LUNA.toString(),
    blockNumber: 990,
    executionResult: true,
    networkId: 5,
    ...overrides,
  };
}

function rpcFor(tx: Record<string, unknown>) {
  return {
    getTransactionByHash: async (hash: string) => ({ ...tx, hash }) as never,
    getBlockNumber: async () => 1000,
  };
}

function fullDoc(partial: {
  id: string;
  creatorId: string;
  maxPlayers?: number;
  entryFeeLuna?: string | null;
  status?: string;
}) {
  return {
    id: partial.id,
    name: `T ${partial.id}`,
    description: "",
    creatorId: partial.creatorId,
    format: "knockout" as const,
    timeControl: "5+0",
    maxPlayers: partial.maxPlayers ?? 8,
    status: (partial.status ?? "registration") as StoreModule.TournamentDocument["status"],
    swissRounds: null,
    createdAt: 1,
    registrationClosesAt: null,
    scheduledStartAt: null,
    startedAt: null,
    completedAt: null,
    currentRound: 0,
    totalRounds: 0,
    winnerId: null,
    entries: [] as StoreModule.TournamentDocument["entries"],
    matches: [],
    standings: [],
    entryFeeLuna: partial.entryFeeLuna ?? FEE_LUNA.toString(),
    prizePreset: "winner" as const,
    payoutStatus: "none" as const,
  };
}

/** Real paid-join deps for player i: their wallet, their fresh tx. */
function paidDeps(i: number, tx: Record<string, unknown>, opts: { guest?: boolean } = {}) {
  return {
    rpc: rpcFor(tx),
    getLinkedWallet: async () => ({ address: walletFor(i), network: "test" as const, linkedAt: 0 }),
    isGuestAccount: async () => opts.guest ?? false,
  } satisfies EconomyModule.JoinPaidDeps;
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-hardening-"));
  process.chdir(root);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NIMIQ_RPC_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = TREASURY;
  process.env.NEXT_PUBLIC_NIMIQ_NETWORK = "test";
  economy = await import("@/lib/server/tournament-economy");
  dispatch = await import("@/lib/server/tournament-payouts-dispatch");
  store = await import("@/lib/server/tournament-store");
  payouts = await import("@/lib/server/tournament-payouts");
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

/* ------------------------------------------------------------------ */
/* STRESS — the real locks under a full-field joining race             */
/* ------------------------------------------------------------------ */

test("STRESS: exactly maxPlayers concurrent paid joins win; extras are rejected; no extra consumption", async () => {
  const id = "tour_stress_field";
  const CAP = 8;
  await store.writeTournamentDoc(fullDoc({ id, creatorId: "acct_host", maxPlayers: CAP }));

  // CAP + 4 players race simultaneously for CAP seats.
  const racers = Array.from({ length: CAP + 4 }, (_, k) => k + 1);
  const settled = await Promise.allSettled(
    racers.map((i) => {
      const tx = validTx(walletFor(i));
      return economy.joinPaidTournament(id, `acct_p${i}`, tx.hash, paidDeps(i, tx));
    }),
  );

  const won = settled.filter((r) => r.status === "fulfilled");
  const lost = settled.filter((r) => r.status === "rejected");
  assert.equal(won.length, CAP);
  assert.equal(lost.length, 4);

  const doc = await store.getTournamentDoc(id);
  assert.ok(doc);
  const active = doc!.entries.filter((e) => e.leftAt === undefined);
  assert.equal(active.length, CAP, "exactly CAP seats exist");
  assert.equal(active.every((e) => e.paid), true, "every seat is marked paid");

  // Every winner consumed their OWN hash; exactly CAP consumption rows exist
  // for this tournament — no overbooking, no lost payment.
  const ledger = await (await import("@/lib/server/nimiq/transactions")).fastStoreTxStore
    .listByTournament!(id);
  assert.equal(ledger.length, CAP);
  const hashes = new Set(ledger.map((r) => r.txHash));
  assert.equal(hashes.size, CAP, "each seat paid with a distinct transaction");
});

test("STRESS: one player racing N different payments produces exactly one seat and one consumption", async () => {
  const id = "tour_stress_same_player";
  await store.writeTournamentDoc(fullDoc({ id, creatorId: "acct_host", maxPlayers: 8 }));

  const txs = [validTx(walletFor(1)), validTx(walletFor(1)), validTx(walletFor(1))];
  const settled = await Promise.allSettled(
    txs.map((tx) => economy.joinPaidTournament(id, "acct_same", tx.hash, paidDeps(1, tx))),
  );

  const wins = settled.filter((s) => s.status === "fulfilled");
  assert.equal(wins.length, 1, "exactly one join succeeds; the other payments are already-paid rejections");

  const doc = await store.getTournamentDoc(id);
  const mine = doc!.entries.filter((e) => e.playerId === "acct_same");
  assert.equal(mine.length, 1);

  const ledger = await (await import("@/lib/server/nimiq/transactions")).fastStoreTxStore
    .listByTournament!(id);
  assert.equal(ledger.filter((r) => r.playerId === "acct_same").length, 1);

  // The two rejected attempts had DIFFERENT real transactions — they stay
  // unconsumed and refundable on-chain.
  const consumedHashes = new Set(ledger.map((r) => r.txHash));
  const unconsumed = txs.filter((tx) => !consumedHashes.has(tx.hash));
  assert.equal(unconsumed.length, 2, "losing payments remain unconsumed");
});

/* ------------------------------------------------------------------ */
/* ADVERSARIAL — replay across tournaments, bad money, guests          */
/* ------------------------------------------------------------------ */

test("ADVERSARY: the same tx hash raced into two tournaments is consumed exactly once; the loser keeps no seat", async () => {
  const idA = "tour_replay_a";
  const idB = "tour_replay_b";
  await store.writeTournamentDoc(fullDoc({ id: idA, creatorId: "acct_host" }));
  await store.writeTournamentDoc(fullDoc({ id: idB, creatorId: "acct_host" }));

  const tx = validTx(walletFor(2));
  const [a, b] = await Promise.allSettled([
    economy.joinPaidTournament(idA, "acct_replayer", tx.hash, paidDeps(2, tx)),
    economy.joinPaidTournament(idB, "acct_replayer", tx.hash, paidDeps(2, tx)),
  ]);

  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "exactly one tournament accepted the payment");

  for (const id of [idA, idB]) {
    const doc = await store.getTournamentDoc(id);
    const row = doc!.entries.find((e) => e.playerId === "acct_replayer");
    if (row) {
      assert.equal(row.paid?.txHash, tx.hash, "the winner's seat references the payment");
    }
  }
  const ledgerA = await (await import("@/lib/server/nimiq/transactions")).fastStoreTxStore
    .listByTournament!(idA);
  const ledgerB = await (await import("@/lib/server/nimiq/transactions")).fastStoreTxStore
    .listByTournament!(idB);
  assert.equal(ledgerA.length + ledgerB.length, 1, "one consumption row total");

  // A third, sequential attempt on the other tournament is also refused.
  const other = fulfilled.length === 1 && a.status === "fulfilled" ? idB : idA;
  await assert.rejects(
    () => economy.joinPaidTournament(other, "acct_replayer", tx.hash, paidDeps(2, tx)),
    (err: EconomyModule.TournamentEntryError) => err.kind === "already-paid",
  );
});

test("ADVERSARY: wrong amount, wrong recipient and guest payments leave NO consumption and NO seat", async () => {
  const id = "tour_adversary";
  await store.writeTournamentDoc(fullDoc({ id, creatorId: "acct_host", maxPlayers: 8 }));

  const cases: Array<{ name: string; tx: Record<string, unknown>; guest?: boolean }> = [
    { name: "underpayment", tx: validTx(walletFor(3), { value: (FEE_LUNA - 1n).toString() }) },
    { name: "overpayment", tx: validTx(walletFor(3), { value: (FEE_LUNA + 1n).toString() }) },
    { name: "wrong recipient", tx: validTx(walletFor(3), { to: walletFor(99) }) },
    { name: "guest", tx: validTx(walletFor(3)), guest: true },
    { name: "failed execution", tx: validTx(walletFor(3), { executionResult: false }) },
  ];

  for (const [n, c] of cases.entries()) {
    const before = await (await import("@/lib/server/nimiq/transactions")).fastStoreTxStore
      .listByTournament!(id);
    await assert.rejects(
      () =>
        economy.joinPaidTournament(
          id,
          `acct_adv_${n}`,
          c.tx.hash as string,
          paidDeps(3, c.tx, { guest: c.guest }),
        ),
      (err: unknown) => err instanceof Error,
      `${c.name} must be rejected`,
    );
    const after = await (await import("@/lib/server/nimiq/transactions")).fastStoreTxStore
      .listByTournament!(id);
    assert.equal(after.length, before.length, `${c.name}: no consumption row appeared`);
    const doc = await store.getTournamentDoc(id);
    assert.equal(
      doc!.entries.some((e) => e.playerId === `acct_adv_${n}`),
      false,
      `${c.name}: no phantom seat remains`,
    );
  }

  // Nothing valid was ever paid in this tournament.
  assert.equal((await store.getTournamentDoc(id))!.entries.length, 0);
});

/* ------------------------------------------------------------------ */
/* STRESS — payout dispatch concurrency + WAL recovery                 */
/* ------------------------------------------------------------------ */

function payoutWorld() {
  const broadcasts: Array<{ to: string; amount: bigint; vsh: number }> = [];
  let height = 5000;
  const signer = {
    getSenderAddress: () => TREASURY,
    getChainHeight: async () => height,
    sendPayout: async (address: string, amountLuna: bigint, vsh?: number) => {
      broadcasts.push({ to: address, amount: amountLuna, vsh: vsh ?? height });
      return nextHash();
    },
  };
  return { broadcasts, signer, bumpHeight: (n: number) => (height += n) };
}

test("STRESS: concurrent dispatches of the same payout broadcast exactly once", async () => {
  const id = "tour_stress_payout";
  const w = payoutWorld();
  await payouts.fastStorePayoutStore.upsert({
    tournamentId: id,
    playerId: "acct_winner",
    payoutRank: 1,
    shareBps: 10_000,
    amountLuna: "1000000",
    destinationAddress: walletFor(50),
    status: "pending",
    payoutTxHash: null,
    sentAt: null,
    verifiedAt: null,
    failureReason: null,
  });

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      dispatch.dispatchPayout(id, "acct_winner", { signer: w.signer as never }),
    ),
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled") as Array<
    PromiseFulfilledResult<PayoutsModule.PayoutRecord>
  >;
  assert.equal(fulfilled.length, 6, "every caller gets a definitive answer");
  assert.equal(new Set(fulfilled.map((r) => r.value.payoutTxHash)).size, 1, "one hash for everyone");
  assert.equal(w.broadcasts.length, 1, "the treasury broadcast exactly once");

  const row = await payouts.fastStorePayoutStore.get(id, "acct_winner");
  assert.equal(row!.status, "sent");
  // Re-dispatch afterwards is an idempotent no-op — never a second payment.
  const again = await dispatch.dispatchPayout(id, "acct_winner", { signer: w.signer as never });
  assert.equal(again.payoutTxHash, row!.payoutTxHash);
  assert.equal(w.broadcasts.length, 1);
});

test("ADVERSARY: WAL crash recovery re-broadcasts the SAME vsh; an expired intent fails closed", async () => {
  const id = "tour_wal_recovery";
  const w = payoutWorld();
  // Simulate the crash: intent recorded, nothing broadcast.
  await payouts.fastStorePayoutStore.upsert({
    tournamentId: id,
    playerId: "acct_crashed",
    payoutRank: 1,
    shareBps: 10_000,
    amountLuna: "750000",
    destinationAddress: walletFor(51),
    status: "dispatching",
    payoutTxHash: null,
    sentAt: null,
    verifiedAt: null,
    failureReason: null,
    network: "test",
    senderAddress: TREASURY,
    validityStartHeight: 4998,
    dispatchAttempts: 1,
    lastBroadcastAt: null,
  });

  const recovered = await dispatch.dispatchPayout(id, "acct_crashed", {
    signer: w.signer as never,
  });
  assert.equal(recovered.status, "sent");
  assert.equal(w.broadcasts.length, 1);
  assert.equal(w.broadcasts[0]!.vsh, 4998, "recovery reuses the recorded validity window");
  assert.equal(w.broadcasts[0]!.amount, 750_000n);

  // An expired intent (chain far past the validity window) fails CLOSED:
  // marked failed, never broadcast.
  const id2 = "tour_wal_expired";
  await payouts.fastStorePayoutStore.upsert({
    tournamentId: id2,
    playerId: "acct_expired",
    payoutRank: 1,
    shareBps: 10_000,
    amountLuna: "750000",
    destinationAddress: walletFor(52),
    status: "dispatching",
    payoutTxHash: null,
    sentAt: null,
    verifiedAt: null,
    failureReason: null,
    network: "test",
    senderAddress: TREASURY,
    validityStartHeight: 100,
    dispatchAttempts: 1,
    lastBroadcastAt: null,
  });
  w.bumpHeight(20_000); // far past 100 + 7200
  const before = w.broadcasts.length;
  await assert.rejects(
    () => dispatch.dispatchPayout(id2, "acct_expired", { signer: w.signer as never }),
    (err: Error) => /expired/i.test(err.message),
  );
  assert.equal(w.broadcasts.length, before, "an expired intent is never broadcast");
  const row = await payouts.fastStorePayoutStore.get(id2, "acct_expired");
  assert.equal(row!.status, "failed");
});

/* ------------------------------------------------------------------ */
/* SCHEMA — migrations stay scoped, durable guards exist               */
/* ------------------------------------------------------------------ */

test("SCHEMA: migration 0008 keeps the cross-instance consumption uniqueness", () => {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, "0008_nimiq_transactions.sql"), "utf8");
  assert.match(sql, /unique/i, "nimiq_transactions needs a UNIQUE (network, tx_hash) guard");
  assert.match(sql, /tx_hash/i);
});

test("SCHEMA: migration 0010 keeps the write-ahead + monotonic payout constraints", () => {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, "0010_payout_dispatch.sql"), "utf8");
  assert.match(sql, /dispatching/i, "the WAL state must be schema-visible");
  assert.match(sql, /check|constraint/i);
  // Phase discipline: no payment vocabulary beyond this phase.
  assert.doesNotMatch(sql, /prize_pool|refund_amount|commission|platform_fee/i);
});

/* ------------------------------------------------------------------ */
/* CONFIG — the network default fails closed                           */
/* ------------------------------------------------------------------ */

test("CONFIG: a missing/typo network env value can never point money code at mainnet", () => {
  assert.equal(nimiqNetworkName(undefined), "test");
  assert.equal(nimiqNetworkName(""), "test");
  assert.equal(nimiqNetworkName("mainnet"), "main");
  assert.equal(nimiqNetworkName("TEST"), "test");
  assert.equal(nimiqNetworkName("garbage"), "test");
});
