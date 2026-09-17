/**
 * Nimiq Phase 1C transaction-verification tests.
 *
 * Drives the real verifyIncomingTransaction() with deterministic fake RPC and
 * store seams — no live Nimiq node needed. Every typed error category, the
 * exact confirmation boundary, replay durability, large-luna exactness and
 * the persistence-only-after-success ordering are covered.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as TxModule from "@/lib/server/nimiq/transactions";
import type * as ProofClientModule from "@/lib/nimiq/proof";
import type * as ServerVerifyModule from "@/lib/server/nimiq/verify";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

let tx: typeof TxModule;
let proofClient: typeof ProofClientModule;
let serverVerify: typeof ServerVerifyModule;

/* Deterministic fakes -------------------------------------------------- */

const LINKED_ADDRESS = "NQ0700000000000000000000000000000000"; // burn-shape, fine as a fake

/** Space-stripped uppercase form, mirroring the server's canonical compare. */
function canonical(address: string): string {
  return address.replace(/[\s-]/g, "").toUpperCase();
}
const TREASURY_ADDRESS = "NQ09V9Q7P4V07V0XGV0XGV0XGV0XGV0XGV0X".replace(/[^A-Z0-9]/g, "").slice(0, 36);

/** FakeTx with the optional fromType field the real v2 node includes. */
interface FakeTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: number | null;
  executionResult?: boolean;
  networkId?: number;
  fromType?: number;
  /** Proof-carrying payments route their signed intent here. */
  data?: unknown;
}

function makeDeps(options: {
  linkedWallet?: { address: string; network: "main" | "test"; linkedAt: number } | null;
  onChainTx?: FakeTx | null;
  currentHeight?: number | null;
  rpcError?: Error;
  consumed?: Map<string, TxModule.VerifiedNimiqTransaction>;
  treasury?: string;
  /** Account objects served by the fake getAccountByAddress, keyed by compact address. */
  accounts?: Record<string, unknown>;
}) {
  const consumed = options.consumed ?? new Map();
  const store: TxModule.NimiqTxStore = {
    async findByNetworkAndHash(network, txHash) {
      return consumed.get(`${network}:${txHash}`) ?? null;
    },
    async insertConsumed(row) {
      const key = `${row.network}:${row.txHash}`;
      if (consumed.has(key)) {
        throw new tx.NimiqTxError("already-consumed", "This transaction was already consumed");
      }
      const id = consumed.size + 1;
      consumed.set(key, { ...row, id, verifiedAt: Date.now() });
      return id;
    },
  };
  if (options.treasury !== undefined) {
    process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = options.treasury;
  }
  const accounts = options.accounts ?? {};
  const lookupAccount = async (address: string): Promise<unknown> => {
    const key = canonical(address);
    if (!(key in accounts)) throw new Error("account not found");
    return accounts[key];
  };
  const rpc = options.rpcError
    ? {
        getTransactionByHash: async (): Promise<never> => {
          throw options.rpcError!;
        },
        getBlockNumber: async (): Promise<never> => {
          throw options.rpcError!;
        },
        getAccountByAddress: lookupAccount,
      }
    : {
        getTransactionByHash: async (hash: string): Promise<FakeTx | null> => {
          if (!options.onChainTx) return null;
          const { hash: templateHash, ...rest } = options.onChainTx;
          // Keep an explicitly-empty template hash: malformed-response tests
          // rely on the node returning a tx object with no usable hash.
          return { ...rest, hash: templateHash === "" ? "" : hash };
        },
        getBlockNumber: async (): Promise<number> => options.currentHeight ?? 1000,
        getAccountByAddress: lookupAccount,
      };
  return {
    deps: {
      getLinkedWallet: async () =>
        options.linkedWallet === undefined
          ? ({ address: LINKED_ADDRESS, network: "test" as const, linkedAt: 0 })
          : options.linkedWallet,
      rpc,
      store,
    },
    consumed,
    store,
  };
}

const BASE_OBLIGATION = {
  playerId: "acct_tx_test_1",
  expectedAmountLuna: 500_000n, // 5 NIM
};

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-nimiq-tx-"));
  process.chdir(root);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NIMIQ_RPC_URL = "http://127.0.0.1:1"; // present but unused (fakes override)
  process.env.NIMIQ_CONFIRMATIONS_REQUIRED = "10";
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = TREASURY_ADDRESS;
  process.env.NEXT_PUBLIC_NIMIQ_NETWORK = "test";
  ed.etc.sha512Async = async (m: Uint8Array) => sha512(m);
  ed.etc.sha512Sync = (m: Uint8Array) => sha512(m);
  tx = await import("@/lib/server/nimiq/transactions");
  proofClient = await import("@/lib/nimiq/proof");
  serverVerify = await import("@/lib/server/nimiq/verify");
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

function validTx(overrides: Partial<FakeTx> = {}): FakeTx {
  return {
    hash: "a".repeat(64),
    from: LINKED_ADDRESS,
    to: TREASURY_ADDRESS,
    value: "500000",
    blockNumber: 991, // currentHeight 1000 → 10 confirmations
    executionResult: true,
    networkId: 5,
    ...overrides,
  };
}

/** Random Ed25519 keypair, hex public key (same idiom as nimiq-wallet.test). */
async function keypairFor(
  _setup: (m: Uint8Array) => void,
): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKeyHex: Buffer.from(pub).toString("hex") };
}

/* ------------------------------------------------------------------ */
/* The happy path                                                      */
/* ------------------------------------------------------------------ */

test("a valid transaction verifies and is consumed exactly once", async () => {
  const { deps, consumed } = makeDeps({ onChainTx: validTx(), currentHeight: 1000 });
  const result = await tx.verifyIncomingTransaction("a".repeat(64), BASE_OBLIGATION, deps);
  assert.equal(result.amountLuna, "500000");
  assert.equal(result.confirmations, 10);
  assert.equal(result.kind, "verification");
  assert.equal(consumed.size, 1);
});

/* ------------------------------------------------------------------ */
/* Input validation                                                    */
/* ------------------------------------------------------------------ */

test("an invalid hash is rejected before any I/O", async () => {
  const { deps } = makeDeps({ onChainTx: validTx() });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("NOT_A_HASH", BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "invalid-hash" && err.status === 400,
  );
  // Uppercase hashes normalize rather than reject.
  const ok = await tx.verifyIncomingTransaction("B".repeat(64), BASE_OBLIGATION, deps);
  assert.equal(ok.txHash, "b".repeat(64));
});

test("a missing linked wallet stops verification (wallet-not-linked)", async () => {
  const { deps } = makeDeps({ linkedWallet: null, onChainTx: validTx() });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("c".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wallet-not-linked" && err.status === 409,
  );
});

/* ------------------------------------------------------------------ */
/* RPC-level failures                                                  */
/* ------------------------------------------------------------------ */

test("transaction not found on the node", async () => {
  const { deps } = makeDeps({ onChainTx: null });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("d".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "transaction-not-found" && err.status === 404,
  );
});

test("a pending (unmined) transaction is not verifiable", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ blockNumber: null }) });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("e".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "transaction-not-found",
  );
});

test("RPC unavailability maps to rpc-unavailable (503) with the underlying reason, not a crash", async () => {
  const { deps } = makeDeps({
    onChainTx: validTx(),
    rpcError: new (await import("@/lib/server/nimiq/rpc")).NimiqRpcError("node down"),
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("f".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) =>
      err instanceof tx.NimiqTxError &&
      err.kind === "rpc-unavailable" &&
      err.status === 503 &&
      // The bare "could not be reached" masked real causes (missing env var,
      // HTTP status, timeout). The underlying reason must survive.
      err.message.includes("node down"),
  );
});

test("malformed RPC payloads map to transaction-not-found or malformed-rpc-response", async () => {
  // Object without a hash (checked before sender/recipient comparisons).
  const bad1 = makeDeps({
    onChainTx: { hash: "", from: LINKED_ADDRESS, to: TREASURY_ADDRESS, value: "1", blockNumber: 5 },
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("1".repeat(64), BASE_OBLIGATION, bad1.deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "transaction-not-found",
  );
  // Non-integer luna value from the node (float corruption attempt).
  const bad2 = makeDeps({ onChainTx: validTx({ value: "12.5" }) });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("2".repeat(64), BASE_OBLIGATION, bad2.deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "malformed-rpc-response" && err.status === 502,
  );
});

/* ------------------------------------------------------------------ */
/* Obligation mismatches                                               */
/* ------------------------------------------------------------------ */

test("failed on-chain execution is rejected", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ executionResult: false }) });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("3".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "failed-transaction" && err.status === 400,
  );
});

test("a missing executionResult verdict fails closed as a malformed RPC response", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ executionResult: undefined }) });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("3".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) =>
      err instanceof tx.NimiqTxError &&
      err.kind === "malformed-rpc-response" &&
      err.status === 502 &&
      /executionResult/.test(err.message),
  );
});

test("a non-boolean executionResult verdict fails closed as a malformed RPC response", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ executionResult: "true" as unknown as boolean }) });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("3".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) =>
      err instanceof tx.NimiqTxError && err.kind === "malformed-rpc-response" && err.status === 502,
  );
});

/* ------------------------------------------------------------------ */
/* Proof-of-signer attribution (the sender-mismatch fix)               */
/* ------------------------------------------------------------------ */

/** Sign `message` the way Nimiq Pay signs messages (SHA-256 over framing). */
async function paySign(message: string, privateKey: Uint8Array): Promise<string> {
  const signed = serverVerify.nimiqMessageSigningHash(message);
  const sig = await ed.signAsync(signed, privateKey);
  return Buffer.from(sig).toString("hex");
}

test("a wrong-sender transaction carrying a VALID proof by the linked wallet's key verifies", async () => {
  // The exact live failure: Nimiq Pay paid from an unknown wrapper contract,
  // NOT the linked identity address. The proof — signed by the linked key —
  // is what attributes the payment now.
  const { privateKey, publicKeyHex } = await keypairFor(ed.etc.sha512Async as unknown as (m: Uint8Array) => void);
  const linkedDerived = serverVerify.addressFromPublicKey(publicKeyHex);
  const obligation = {
    playerId: "acct_proof_flow",
    expectedAmountLuna: 10_000_000n, // 100 NIM
    kind: "tournament_entry" as const,
    tournamentId: "tour_proof_flow",
  };
  const message = proofClient.proofMessage({
    playerId: obligation.playerId,
    tournamentId: obligation.tournamentId,
    amountLuna: obligation.expectedAmountLuna.toString(),
    recipient: canonical(TREASURY_ADDRESS),
    network: "test",
  });
  const signature = await paySign(message, privateKey);
  const proofData = proofClient.encodeProofDataHex({ publicKey: publicKeyHex, signature });

  const { deps, consumed } = makeDeps({
    onChainTx: validTx({
      from: "NQ54 MXBG XVSB C6FN 0YG2 QGGH NB5E A531 7G01", // the wrapper contract
      fromType: 2,
      value: "10000000",
      data: proofData,
    }),
    currentHeight: 1000,
    linkedWallet: { address: linkedDerived, network: "test", linkedAt: 0 },
  });
  const result = await tx.verifyIncomingTransaction("c".repeat(64), obligation, deps);
  assert.equal(consumed.size, 1);
  assert.equal(result.amountLuna, "10000000");
});

test("a wrong-sender transaction with NO proof is still rejected (legacy path intact)", async () => {
  const { privateKey, publicKeyHex } = await keypairFor(ed.etc.sha512Async as unknown as (m: Uint8Array) => void);
  const linkedDerived = serverVerify.addressFromPublicKey(publicKeyHex);
  const { deps } = makeDeps({
    onChainTx: validTx({
      from: "NQ54 MXBG XVSB C6FN 0YG2 QGGH NB5E A531 7G01",
      fromType: 2,
    }),
    linkedWallet: { address: linkedDerived, network: "test", linkedAt: 0 },
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("d".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-sender",
  );
});

test("a proof signed by a DIFFERENT key than the linked wallet is authoritative rejection", async () => {
  // Someone else's key signed the intent: even though the (unused here)
  // linked wallet matches the claimed publicKey, the signature is invalid —
  // and no fallback may rescue a cryptographically wrong proof.
  const { privateKey, publicKeyHex } = await keypairFor(ed.etc.sha512Async as unknown as (m: Uint8Array) => void);
  const attacker = await keypairFor(ed.etc.sha512Async as unknown as (m: Uint8Array) => void);
  const linkedDerived = serverVerify.addressFromPublicKey(publicKeyHex);
  const message = proofClient.proofMessage({
    playerId: "acct_x",
    tournamentId: "tour_x",
    amountLuna: "10000000",
    recipient: canonical(TREASURY_ADDRESS),
    network: "test",
  });
  const signature = await paySign(message, attacker.privateKey);
  const proofData = proofClient.encodeProofDataHex({ publicKey: publicKeyHex, signature });

  const { deps } = makeDeps({
    onChainTx: validTx({
      from: "NQ54 MXBG XVSB C6FN 0YG2 QGGH NB5E A531 7G01",
      fromType: 2,
      value: "10000000",
      data: proofData,
    }),
    linkedWallet: { address: linkedDerived, network: "test", linkedAt: 0 },
  });
  await assert.rejects(
    () =>
      tx.verifyIncomingTransaction("e".repeat(64), {
        playerId: "acct_x",
        expectedAmountLuna: 10_000_000n,
        kind: "tournament_entry",
        tournamentId: "tour_x",
      }, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-sender",
  );
});

test("wrong sender (not the linked wallet) is rejected", async () => {
  const { deps } = makeDeps({
    onChainTx: validTx({ from: "NQ11 2222 3334 4444 5555 6666 7777 8888 9999" }),
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("4".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => {
      if (!(err instanceof tx.NimiqTxError) || err.kind !== "wrong-sender" || err.status !== 400) {
        return false;
      }
      // The message must name BOTH addresses (rendered in the friendly
      // spaced form users see in Nimiq Pay). Compare space-stripped.
      const compact = err.message.replace(/[\s-]/g, "");
      return (
        compact.includes("NQ1122223334444455556666777788889999") &&
        compact.includes(canonical(LINKED_ADDRESS))
      );
    },
  );
});

test("wrong sender from a contract-type account gets the contract hint", async () => {
  // Real shape observed on the live testnet node: Nimiq Pay paid through an
  // HTLC contract account (fromType 2) instead of the linked basic account.
  const { deps } = makeDeps({
    onChainTx: validTx({
      from: "NQ44 QSMT XNNB BFJG 8Q07 AJ1F DNHA LYGU GX5B",
      fromType: 2,
    } as unknown as Partial<FakeTx>),
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("e".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) =>
      err instanceof tx.NimiqTxError &&
      err.kind === "wrong-sender" &&
      err.message.includes("not one created by your linked wallet"),
  );
});

test("a payment from an HTLC contract CREATED BY the linked wallet is accepted", async () => {
  // Verified live on testnet: Nimiq Pay's sendBasicTransaction pays from HTLC
  // wrapper contracts whose creator (`sender` field) is the linked wallet —
  // only the linked key could create it or reclaim its funds.
  const HTLC = "NQ83S0796YS4DGCLVBV8449NJJ57TC0P0TVH";
  const { deps, consumed } = makeDeps({
    onChainTx: validTx({
      from: "NQ83 S079 6YS4 DGCL VBV8 449N JJ57 TC0P 0TVH",
      fromType: 2,
    } as unknown as Partial<FakeTx>),
    accounts: {
      [HTLC]: {
        address: HTLC,
        balance: 21999800000,
        type: "htlc",
        sender: LINKED_ADDRESS, // creator = linked wallet
        totalAmount: 22000000000,
      },
    },
  });
  const result = await tx.verifyIncomingTransaction("d".repeat(64), BASE_OBLIGATION, deps);
  assert.equal(result.amountLuna, "500000");
  assert.equal(consumed.size, 1);
});

test("a payment from a contract created by someone ELSE is still rejected", async () => {
  const HTLC = "NQ83S0796YS4DGCLVBV8449NJJ57TC0P0TVH";
  const { deps } = makeDeps({
    onChainTx: validTx({
      from: "NQ83 S079 6YS4 DGCL VBV8 449N JJ57 TC0P 0TVH",
      fromType: 2,
    } as unknown as Partial<FakeTx>),
    accounts: {
      [HTLC]: {
        address: HTLC,
        type: "htlc",
        sender: "NQ54FTGYF6VJEJPUNSMNRA5Q0K218EQTQ05P", // someone else
      },
    },
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("c".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-sender",
  );
});

test("contract-ownership lookup failure fails closed (plain wrong-sender)", async () => {
  const { deps } = makeDeps({
    onChainTx: validTx({
      from: "NQ83 S079 6YS4 DGCL VBV8 449N JJ57 TC0P 0TVH",
      fromType: 2,
    } as unknown as Partial<FakeTx>),
    // No `accounts` entry: the fake lookup throws, as a down node would.
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("b".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-sender",
  );
});

test("wrong recipient (not the treasury) is rejected", async () => {
  const { deps } = makeDeps({
    onChainTx: validTx({ to: "NQ11 2222 3333 4444 5555 6666 7777 8888 9999" }),
  });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("5".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-recipient" && err.status === 400,
  );
});

test("wrong amount is rejected — even one luna off", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ value: "499999" }) });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("6".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-amount" && err.status === 400,
  );
});

test("wrong network (networkId mismatch) is rejected", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ networkId: 42 }) }); // mainnet tx, test obligation
  await assert.rejects(
    () => tx.verifyIncomingTransaction("7".repeat(64), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-network" && err.status === 400,
  );
});

/* ------------------------------------------------------------------ */
/* Confirmations — the exact boundary                                  */
/* ------------------------------------------------------------------ */

test("confirmations = currentHeight − txHeight + 1; requirement is inclusive", async () => {
  // tx in block 991, chain at 1000 → 10 confirmations; required 10 → PASS.
  const pass = makeDeps({ onChainTx: validTx({ blockNumber: 991 }), currentHeight: 1000 });
  const ok = await tx.verifyIncomingTransaction("8".repeat(64), BASE_OBLIGATION, pass.deps);
  assert.equal(ok.confirmations, 10);
});

test("one confirmation short of the threshold is rejected", async () => {
  // tx in block 992, chain at 1000 → 9 confirmations; required 10 → FAIL.
  const fail = makeDeps({ onChainTx: validTx({ blockNumber: 992 }), currentHeight: 1000 });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("9".repeat(64), BASE_OBLIGATION, fail.deps),
    (err: unknown) =>
      err instanceof tx.NimiqTxError &&
      err.kind === "insufficient-confirmations" &&
      err.status === 409 &&
      /9 confirmations, 10 required/.test(err.message),
  );
});

test("a transaction ahead of the chain height can never yield positive confirmations", async () => {
  // Malicious/buggy node reports a future block: confirmations would be <= 0.
  const weird = makeDeps({ onChainTx: validTx({ blockNumber: 2000 }), currentHeight: 1000 });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("a1".repeat(32), BASE_OBLIGATION, weird.deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "insufficient-confirmations",
  );
});

/* ------------------------------------------------------------------ */
/* Replay protection                                                   */
/* ------------------------------------------------------------------ */

test("the same transaction cannot be consumed twice (replay protection)", async () => {
  const { deps } = makeDeps({ onChainTx: validTx(), currentHeight: 1000 });
  await tx.verifyIncomingTransaction("b1".repeat(32), BASE_OBLIGATION, deps);
  await assert.rejects(
    () => tx.verifyIncomingTransaction("b1".repeat(32), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "already-consumed" && err.status === 409,
  );
});

test("replay is keyed per network — the same hash on another network is a different row", async () => {
  const consumed = new Map<string, TxModule.VerifiedNimiqTransaction>();
  const first = makeDeps({ onChainTx: validTx(), currentHeight: 1000, consumed });
  await tx.verifyIncomingTransaction("c1".repeat(32), BASE_OBLIGATION, first.deps);
  const second = makeDeps({ onChainTx: validTx({ networkId: 42 }), currentHeight: 1000, consumed });
  // Same hash, different network obligation → not a replay of the first.
  // The fake tx's networkId matches the main obligation (42).
  const ok = await tx.verifyIncomingTransaction("c1".repeat(32), { ...BASE_OBLIGATION, network: "main" }, second.deps);
  assert.equal(ok.network, "main");
  assert.equal(consumed.size, 2);
});

test("failed verification persists nothing (retry possible after confirmations)", async () => {
  const { deps, consumed } = makeDeps({ onChainTx: validTx({ blockNumber: 992 }), currentHeight: 1000 });
  await assert.rejects(
    () => tx.verifyIncomingTransaction("d1".repeat(32), BASE_OBLIGATION, deps),
    (err: unknown) => err instanceof tx.NimiqTxError,
  );
  assert.equal(consumed.size, 0, "a failed verification must not leave a consumption row");
  // Now the chain advances; the same transaction verifies.
  const later = makeDeps({ onChainTx: validTx({ blockNumber: 992 }), currentHeight: 1001, consumed });
  const ok = await tx.verifyIncomingTransaction("d1".repeat(32), BASE_OBLIGATION, later.deps);
  assert.equal(ok.confirmations, 10);
});

/* ------------------------------------------------------------------ */
/* Exact money                                                         */
/* ------------------------------------------------------------------ */

test("large luna values survive without floating-point corruption", async () => {
  // 9007199254740993 > Number.MAX_SAFE_INTEGER — a float would corrupt it.
  const big = "9007199254740993";
  const { deps } = makeDeps({
    onChainTx: validTx({ value: big }),
    currentHeight: 1000,
  });
  const ok = await tx.verifyIncomingTransaction("e1".repeat(32), {
    playerId: "acct_tx_test_1",
    expectedAmountLuna: BigInt(big),
  }, deps);
  assert.equal(ok.amountLuna, big);
});

test("wrong amount detection works at huge magnitudes too", async () => {
  const { deps } = makeDeps({ onChainTx: validTx({ value: "9007199254740992" }) }); // one luna less
  await assert.rejects(
    () =>
      tx.verifyIncomingTransaction("f1".repeat(32), {
        playerId: "acct_tx_test_1",
        expectedAmountLuna: 9007199254740993n,
      }, deps),
    (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "wrong-amount",
  );
});

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

test("a missing treasury address is a configuration error (503)", async () => {
  const { deps } = makeDeps({ onChainTx: validTx(), treasury: "" });
  const original = process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS;
  delete process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS;
  try {
    // The obligation passes no explicit recipient → falls back to config.
    await assert.rejects(
      () => tx.verifyIncomingTransaction("1a".repeat(32), BASE_OBLIGATION, deps),
      (err: unknown) => err instanceof tx.NimiqTxError && err.kind === "configuration-error" && err.status === 503,
    );
  } finally {
    process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = original ?? TREASURY_ADDRESS;
  }
});
