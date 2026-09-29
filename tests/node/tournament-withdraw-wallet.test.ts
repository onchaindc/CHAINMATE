/**
 * Wallet-path pool withdrawals — withdrawals WITHOUT a signing node.
 *
 * This deployment has no treasury payout node: NIMIQ_PAYOUT_RPC_URL is unset
 * and the only configured endpoint is a read-only gateway, so node-path
 * withdrawals always died with "payout endpoint can't sign transactions".
 * The wallet path fixes that without weakening a single money rule: the
 * ADMIN pays the withdrawal to themselves from the same linked wallet that
 * tops pools up (Nimiq Pay), and ChainMate verifies the REAL on-chain
 * transaction — sender, recipient, value, network, execution, replay guard.
 *
 * Pinned here:
 *   - prepare returns the linked wallet + amount after every gate passes
 *     (pure read: no ledger row is written);
 *   - claim accepts the admin's own transaction and records it 'sent' with
 *     the real hash, counted against the cap immediately;
 *   - the claim re-runs the money gates against the tx's own value, so an
 *     over-the-cap send is refused and nothing is recorded;
 *   - a tx from a stranger's wallet is refused (wrong-sender);
 *   - a failed on-chain execution is refused;
 *   - a hash already consumed by any payment can never settle a withdrawal;
 *   - a same-hash retry converges; a different hash while in flight refuses;
 *   - the confirm flow verifies a wallet row against its recorded sender.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as WithdrawModule from "@/lib/server/tournament-withdraw";
import type * as WalletModule from "@/lib/server/tournament-withdraw-wallet";
import type * as TxModule from "@/lib/server/nimiq/transactions";

let withdraw: typeof WithdrawModule;
let wallet: typeof WalletModule;
let tx: typeof TxModule;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const ADMIN_WALLET = "NQ0700000000000000000000000000000000";
const STRANGER_WALLET = "NQ0800000000000000000000000000000000";
const TREASURY = "NQ09V9Q7P4V07V0XGV0XGV0XGV0XGV0XGV0X".replace(/[^A-Z0-9]/g, "").slice(0, 36);

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

function emptyPayoutStore(): NonNullable<WithdrawModule.WithdrawDeps["payoutStore"]> {
  return {
    async listByTournament() {
      return [];
    },
  } as unknown as NonNullable<WithdrawModule.WithdrawDeps["payoutStore"]>;
}

/** The admin's real on-chain withdrawal tx, as the node would report it. */
function adminTx(
  hash: string,
  over: Partial<{ from: string; to: string; value: string; executionResult: boolean; blockNumber: number }> = {},
) {
  return {
    hash,
    from: ADMIN_WALLET,
    to: ADMIN_WALLET,
    value: "200000", // 2 NIM
    blockNumber: 990,
    executionResult: true,
    networkId: 5, // testnet
    ...over,
  };
}

function walletDeps(
  txStore: ReturnType<typeof makeTxStore>,
  over: Partial<WithdrawModule.WithdrawDeps> = {},
): WithdrawModule.WithdrawDeps {
  return {
    getDoc: (async () => ({
      id: "tour_live",
      status: "in_progress",
      creatorId: "acct_host",
    })) as unknown as WithdrawModule.WithdrawDeps["getDoc"],
    isAdmin: async (pid: string) => pid === "acct_admin",
    getTreasuryAddress: () => TREASURY,
    getLinkedWallet: async (pid: string) =>
      pid === "acct_admin" ? { address: ADMIN_WALLET, network: "test" } : null,
    store: makeWithdrawStore(),
    payoutStore: emptyPayoutStore(),
    txStore,
    getBlockNumber: async () => 1000,
    getTransactionByHash: async (hash: string) => adminTx(hash),
    ...over,
  };
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-withdraw-wallet-"));
  process.chdir(root);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NIMIQ_RPC_URL = "http://127.0.0.1:1";
  process.env.NIMIQ_CONFIRMATIONS_REQUIRED = "10";
  // Hermetic: a real server-side treasury from .env.local must not leak in
  // — including the payout-node pair, which would make confirm's config
  // read throw instead of returning the typed-off null.
  delete process.env.NIMIQ_TREASURY_ADDRESS;
  delete process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS;
  delete process.env.NIMIQ_PAYOUT_RPC_URL;
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = TREASURY;
  process.env.NEXT_PUBLIC_NIMIQ_NETWORK = "test";
  tx = await import("@/lib/server/nimiq/transactions");
  withdraw = await import("@/lib/server/tournament-withdraw");
  wallet = await import("@/lib/server/tournament-withdraw-wallet");

  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
});

/* ------------------------------------------------------------------ */
/* Prepare — the wire facts, gates enforced, pure read                 */
/* ------------------------------------------------------------------ */

test("prepare returns the linked wallet and amount without writing a ledger row", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore);
  const intent = await wallet.preparePoolWithdrawal("tour_live", "acct_admin", "2", deps);
  assert.equal(intent.recipientAddress, ADMIN_WALLET);
  assert.equal(intent.amountLuna, "200000");
  assert.equal(intent.network, "test");
  const rows = await deps.store!.listByTournament("tour_live");
  assert.equal(rows.length, 0, "prepare is a pure read — no intent row exists");
});

test("prepare refuses an amount above the cap", async () => {
  const txStore = await seededPool(); // 50 NIM pool, all uncommitted
  const deps = walletDeps(txStore);
  await assert.rejects(
    wallet.preparePoolWithdrawal("tour_live", "acct_admin", "51", deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "insufficient-available",
  );
});

test("prepare refuses non-admins", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore);
  await assert.rejects(
    wallet.preparePoolWithdrawal("tour_live", "acct_player", "2", deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "not-admin",
  );
});

/* ------------------------------------------------------------------ */
/* Claim — the real transaction, every gate re-run                     */
/* ------------------------------------------------------------------ */

test("claim records the admin's real transaction as a sent withdrawal", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore);
  const { withdrawal, confirmations } = await wallet.claimPoolWithdrawalWithWalletTransaction(
    "tour_live",
    "acct_admin",
    "a1".padEnd(64, "0"),
    deps,
  );
  assert.equal(withdrawal.status, "sent");
  assert.equal(withdrawal.via, "wallet");
  assert.equal(withdrawal.amountLuna, "200000");
  assert.equal(withdrawal.recipientAddress, ADMIN_WALLET);
  assert.ok(withdrawal.withdrawTxHash);
  assert.equal(confirmations, 11); // height 1000 − block 990 + 1

  // Counted against the cap immediately — the pool shrank by 2 NIM.
  const cap = await withdraw.availablePoolLuna("tour_live", deps);
  assert.equal(cap.availableLuna, 48n * 100000n);
});

test("claim refuses a transaction over the cap and records nothing", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore, {
    getTransactionByHash: async (hash: string) => adminTx(hash, { value: "51000000" }), // 51 NIM
  });
  await assert.rejects(
    wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "b1".padEnd(64, "0"), deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "insufficient-available",
  );
  const rows = await deps.store!.listByTournament("tour_live");
  assert.equal(rows.length, 0, "a refused claim leaves no withdrawal row");
});

test("claim refuses a stranger's transaction (wrong sender)", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore, {
    getTransactionByHash: async (hash: string) => adminTx(hash, { from: STRANGER_WALLET }),
  });
  await assert.rejects(
    wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "c1".padEnd(64, "0"), deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "wrong-sender",
  );
});

test("claim refuses a failed on-chain execution", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore, {
    getTransactionByHash: async (hash: string) => adminTx(hash, { executionResult: false }),
  });
  await assert.rejects(
    wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "d1".padEnd(64, "0"), deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "failed-execution",
  );
});

test("a hash already consumed by another payment can never settle a withdrawal", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore);
  // The pool entries themselves are consumed hashes — try claiming one.
  await assert.rejects(
    wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "e0".padEnd(64, "0"), deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "already-consumed",
  );
});

test("a same-hash retry converges instead of double-claiming", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore);
  const hash = "a1".padEnd(64, "0");
  const first = await wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", hash, deps);
  const again = await wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", hash, deps);
  assert.equal(again.withdrawal.id, first.withdrawal.id);
});

test("a second withdrawal cannot start while one is in flight", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore);
  await wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "a1".padEnd(64, "0"), deps);
  await assert.rejects(
    wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "b9".padEnd(64, "0"), deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "withdrawal-in-flight",
  );
});

test("the confirm flow verifies a wallet row against its recorded sender", async () => {
  const txStore = await seededPool();
  const hash = "f1".padEnd(64, "0");
  const deps = walletDeps(txStore, {
    // blockNumber 990 against height 1000 → 11 confirmations ≥ required 10.
    getTransactionByHash: async (h: string) => adminTx(h, { blockNumber: 990 }),
  });
  await wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", hash, deps);
  // The treasury is NOT the sender here — the admin's own wallet is. The
  // node-path sender check would fail this; the wallet row must pass.
  const record = await withdraw.confirmPoolWithdrawal("tour_live", "acct_admin", deps);
  assert.equal(record.status, "verified");
  assert.equal(record.withdrawTxHash, hash);
});

test("ended tournaments refuse the wallet path too", async () => {
  const txStore = await seededPool();
  const deps = walletDeps(txStore, {
    getDoc: (async () => ({
      id: "tour_live",
      status: "completed",
      creatorId: "acct_host",
    })) as unknown as WithdrawModule.WithdrawDeps["getDoc"],
  });
  await assert.rejects(
    wallet.claimPoolWithdrawalWithWalletTransaction("tour_live", "acct_admin", "a2".padEnd(64, "0"), deps),
    (err: WithdrawModule.WithdrawError) => err.kind === "tournament-ended",
  );
});
