/**
 * Prize-pool withdrawals — the mirror of the top-up rule.
 *
 * Pins the gate that decides WHEN pool money may leave:
 *   - withdrawals come OUT of LIVE events only, exactly as top-ups only go
 *     INTO live events (tournament-topup.test.ts pins that side);
 *   - completed and cancelled events refuse outright (tournament-ended);
 *   - a live event lets the admin pull uncommitted surplus, where the pool
 *     is read from real verified on-chain consumption rows, never a client
 *     number;
 *   - the withdrawal immediately counts against the cap, and the cap
 *     refuses to release money already promised to prizes.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as WithdrawModule from "@/lib/server/tournament-withdraw";
import type * as TxModule from "@/lib/server/nimiq/transactions";

let withdraw: typeof WithdrawModule;
let tx: typeof TxModule;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const ADMIN_WALLET = "NQ0700000000000000000000000000000000";
const TREASURY = "NQ09V9Q7P4V07V0XGV0XGV0XGV0XGV0XGV0X".replace(/[^A-Z0-9]/g, "").slice(0, 36);

/** The fake tournament doc — only the fields the withdraw path reads. */
interface FakeDoc {
  id: string;
  status: string;
  creatorId: string;
}

/** A signer that broadcasts instantly with a unique, real-shaped hash. */
let signerSeq = 100;
function okSigner(): NonNullable<WithdrawModule.WithdrawDeps["signer"]> {
  return {
    async sendPayout() {
      signerSeq += 1;
      return `c${signerSeq.toString().padStart(63, "0")}`;
    },
  };
}

/** In-memory consumption store — the pool ledger in miniature. */
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

/** A pool of 50 NIM: ten verified 5 NIM entries, read by the REAL engine. */
async function seededPool() {
  const txStore = makeTxStore();
  for (let i = 0; i < 10; i++) {
    await txStore.insertConsumed({
      network: "test",
      txHash: `e${i.toString().padStart(63, "0")}`,
      playerId: "acct_p1",
      kind: "tournament_entry",
      tournamentId: "tour_live",
      sender: ADMIN_WALLET,
      recipient: TREASURY,
      amountLuna: "500000",
      blockNumber: 1,
      confirmations: 99,
    });
  }
  return txStore;
}

/** In-memory withdrawal ledger — same shape as fastStoreWithdrawStore. */
function makeWithdrawStore(): NonNullable<WithdrawModule.WithdrawDeps["store"]> {
  const rows: WithdrawModule.WithdrawRecord[] = [];
  return {
    async listByTournament(tournamentId: string) {
      return rows.filter((r) => r.tournamentId === tournamentId).sort((a, b) => a.requestedAt - b.requestedAt);
    },
    async append(row: WithdrawModule.WithdrawRecord) {
      rows.push(row);
    },
    async replace(row: WithdrawModule.WithdrawRecord) {
      const idx = rows.findIndex((r) => r.id === row.id);
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
    },
  };
}

/** An empty payout ledger — nothing promised yet. */
function emptyPayoutStore(): NonNullable<WithdrawModule.WithdrawDeps["payoutStore"]> {
  return {
    async listByTournament() {
      return [];
    },
  } as unknown as NonNullable<WithdrawModule.WithdrawDeps["payoutStore"]>;
}

/** Deps fakes: doc seam + admin gate + linked wallet + a signer that works. */
function fullDeps(
  docOver: Partial<FakeDoc> = {},
  over: Partial<WithdrawModule.WithdrawDeps> = {},
): WithdrawModule.WithdrawDeps {
  return {
    getDoc: (async () => ({
      id: "tour_live",
      status: "in_progress",
      creatorId: "acct_host",
      ...docOver,
    })) as unknown as WithdrawModule.WithdrawDeps["getDoc"],
    isAdmin: async (pid: string) => pid === "acct_admin",
    getTreasuryAddress: () => TREASURY,
    getLinkedWallet: async () => ({ address: ADMIN_WALLET, network: "test" }),
    store: makeWithdrawStore(),
    payoutStore: emptyPayoutStore(),
    signer: okSigner(),
    getBlockNumber: async () => 1000,
    ...over,
  };
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-withdraw-"));
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
  withdraw = await import("@/lib/server/tournament-withdraw");

  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
});

/* ------------------------------------------------------------------ */
/* The live-only gate — the mirror of the top-up rule                  */
/* ------------------------------------------------------------------ */

test("completed tournaments refuse withdrawals (the pool is spoken for)", async () => {
  const txStore = await seededPool();
  await assert.rejects(
    () =>
      withdraw.withdrawPool("tour_live", "acct_admin", "2", fullDeps({ status: "completed" }, { txStore })),
    (err: unknown) =>
      err instanceof withdraw.WithdrawError && err.kind === "tournament-ended" && err.status === 409,
  );
});

test("cancelled tournaments refuse withdrawals (the pool is being refunded)", async () => {
  const txStore = await seededPool();
  await assert.rejects(
    () =>
      withdraw.withdrawPool("tour_live", "acct_admin", "2", fullDeps({ status: "cancelled" }, { txStore })),
    (err: unknown) =>
      err instanceof withdraw.WithdrawError && err.kind === "tournament-ended" && err.status === 409,
  );
});

test("only ChainMate (admin) can withdraw", async () => {
  await assert.rejects(
    () => withdraw.withdrawPool("tour_live", "acct_random", "2", fullDeps()),
    (err: unknown) => err instanceof withdraw.WithdrawError && err.kind === "not-admin",
  );
});

/* ------------------------------------------------------------------ */
/* The happy path — uncommitted surplus leaves a LIVE event            */
/* ------------------------------------------------------------------ */

test("a live event lets the admin withdraw uncommitted surplus", async () => {
  const txStore = await seededPool();
  const deps = fullDeps({}, { txStore });

  const result = await withdraw.withdrawPool("tour_live", "acct_admin", "2", deps);
  assert.equal(result.amountLuna, "200000", "exactly 2 NIM in luna, no float dust");
  assert.equal(result.status, "sent");
  assert.match(result.withdrawTxHash ?? "", /^[0-9a-f]{64}$/, "a real transaction hash was recorded");
  assert.equal(result.recipientAddress, ADMIN_WALLET, "destination is the linked wallet, resolved server-side");
  assert.equal(result.availableLunaAfter, "4800000", "50 NIM pool − 2 NIM withdrawn = 48 NIM uncommitted");
});

test("a sent withdrawal immediately counts against the cap", async () => {
  const txStore = await seededPool();
  const deps = fullDeps({}, { txStore });

  const first = await withdraw.withdrawPool("tour_live", "acct_admin", "2", deps);
  assert.equal(first.status, "sent");

  const cap = await withdraw.availablePoolLuna("tour_live", deps);
  assert.equal(cap.poolLuna, 5_000_000n, "the pool is the real verified ledger");
  assert.equal(cap.committedLuna, 200_000n, "the in-flight withdrawal is locked");
  assert.equal(cap.availableLuna, 4_800_000n);
});

test("the cap never releases money promised to planned payouts", async () => {
  const txStore = await seededPool();
  const deps = fullDeps(
    {},
    {
      txStore,
      // 49 of the 50 NIM pool is planned as prizes — only 1 NIM is free.
      payoutStore: {
        async listByTournament() {
          return [
            {
              tournamentId: "tour_live",
              playerId: "acct_w1",
              payoutRank: 1,
              shareBps: 9_800,
              amountLuna: "4900000",
              status: "pending",
            },
          ];
        },
      } as unknown as NonNullable<WithdrawModule.WithdrawDeps["payoutStore"]>,
    },
  );

  await assert.rejects(
    () => withdraw.withdrawPool("tour_live", "acct_admin", "2", deps),
    (err: unknown) => err instanceof withdraw.WithdrawError && err.kind === "insufficient-available",
  );
  // The exact boundary is allowed: exactly the uncommitted 1 NIM leaves.
  const ok = await withdraw.withdrawPool("tour_live", "acct_admin", "1", deps);
  assert.equal(ok.amountLuna, "100000");
  assert.equal(ok.status, "sent");
});
