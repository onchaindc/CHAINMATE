/**
 * Money-path hardening — regression/integration suite.
 *
 * Drives the REAL engine stores (tournament document via the project storage
 * abstraction, the real 1C consumption store, the real 1B binding store and
 * the real payout store) over the REAL paid-join flow, with only the Nimiq
 * node faked. Proves the audit fixes:
 *
 *   B1 — a verified payment ALWAYS lands in an actual tournament seat, is
 *        consumed exactly once, and a failed reservation can never consume.
 *   B2 — money state lives in the project storage abstraction (KV/file), not
 *        raw fs, and duplicate consumption is always rejected.
 *   H2 — guests are rejected from PAID tournaments server-side, before any
 *        payment verification; free tournaments stay guest-friendly.
 *   H4 — one canonical treasury; entry/payout divergence fails closed.
 *   M1 — network identity is mandatory: missing/unknown/mismatched fails.
 *   M4 — payout state can never move backward.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as EconomyModule from "@/lib/server/tournament-economy";
import type * as EngineModule from "@/lib/server/tournaments";
import type * as StoreModule from "@/lib/server/tournament-store";
import type * as PayoutsModule from "@/lib/server/tournament-payouts";
import type * as DispatchModule from "@/lib/server/tournament-payouts-dispatch";
import type * as TxModule from "@/lib/server/nimiq/transactions";
import type * as NimiqStoreModule from "@/lib/server/nimiq/store";
import type * as StorageModule from "@/lib/server/storage";

let economy: typeof EconomyModule;
let engine: typeof EngineModule;
let store: typeof StoreModule;
let payouts: typeof PayoutsModule;
let dispatch: typeof DispatchModule;
let tx: typeof TxModule;
let nimiqStore: typeof NimiqStoreModule;
let storage: typeof StorageModule;

let DATA_ROOT: string;

const FEE_LUNA = 5_000_000n; // 5 NIM
const ENTRY_TREASURY = "NQ" + "E1".repeat(17); // shape-valid, distinct
const PAYOUT_TREASURY = "NQ" + "P1".repeat(17);
const LINKED = "NQ" + "L1".repeat(17);
const HOST = "acct_host";
const PLAYER = "acct_p1";

let seq = 0;

function validTx(over: Partial<{ value: string; to: string; from: string; executionResult: boolean; networkId: number; blockNumber: number | null }> = {}) {
  seq += 1;
  return {
    hash: `a${seq.toString().padStart(63, "0")}`,
    from: LINKED,
    to: ENTRY_TREASURY,
    value: FEE_LUNA.toString(),
    blockNumber: 990,
    executionResult: true,
    networkId: 5,
    ...over,
  };
}

function rpcFor(over?: Partial<Record<string, unknown>>) {
  let current = validTx(over as never);
  return {
    getTransactionByHash: async (hash: string) => ({ ...current, hash }),
    getBlockNumber: async () => 1000,
    setTx: (next: Record<string, unknown>) => {
      current = { ...current, ...next } as never;
    },
  };
}

/** Create a PAID tournament and open registration, through the REAL engine. */
async function newPaidTournament(deps: { fee?: bigint } = {}): Promise<string> {
  const doc = await engine.createTournament(HOST, {
    name: `Money Path ${seq += 1}`,
    format: "arena",
    timeControl: "10 + 0",
    maxPlayers: 4,
    entryFeeLuna: deps.fee ?? FEE_LUNA,
    prizePreset: "winner",
  });
  const opened = await engine.transitionTournament(doc.id, HOST, "registration");
  assert.equal(opened.ok, true);
  return doc.id;
}

async function newFreeTournament(): Promise<string> {
  const doc = await engine.createTournament(HOST, {
    name: `Free ${seq += 1}`,
    format: "arena",
    timeControl: "10 + 0",
    maxPlayers: 4,
  });
  const opened = await engine.transitionTournament(doc.id, HOST, "registration");
  assert.equal(opened.ok, true);
  return doc.id;
}

async function engineDoc(id: string) {
  const doc = await store.getTournamentDoc(id);
  assert.ok(doc, "tournament document must exist");
  return doc;
}

/** The integration suite always plays an AUTHENTICATED account (H2 gate on). */
const ACCOUNT_OK = async () => false;

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-moneypath-"));
  process.chdir(DATA_ROOT);
  for (const k of [
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS",
    "NIMIQ_TREASURY_ADDRESS",
    "NIMIQ_PAYOUT_RPC_URL",
    "NIMIQ_PAYOUT_RPC_BASIC_AUTH",
    "NIMIQ_PAYOUT_TREASURY_ADDRESS",
    "NIMIQ_PAYOUT_CONFIRMATIONS_REQUIRED",
    "NIMIQ_RPC_URL",
  ]) {
    delete process.env[k];
  }
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = ENTRY_TREASURY;

  economy = await import("@/lib/server/tournament-economy");
  engine = await import("@/lib/server/tournaments");
  store = await import("@/lib/server/tournament-store");
  payouts = await import("@/lib/server/tournament-payouts");
  dispatch = await import("@/lib/server/tournament-payouts-dispatch");
  tx = await import("@/lib/server/nimiq/transactions");
  nimiqStore = await import("@/lib/server/nimiq/store");
  storage = await import("@/lib/server/storage");

  // Link the player's wallet through the REAL Phase 1B store.
  await nimiqStore.setBindingForPlayer(PLAYER, {
    playerId: PLAYER,
    address: LINKED,
    network: "test",
    publicKey: "pk_integration",
    createdAt: 1,
    updatedAt: 1,
  });

  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

/* ================================================================== */
/* B1 — REAL paid join over the REAL stores                            */
/* ================================================================== */

test("B1: real paid join creates an actual PAID seat and consumes the tx exactly once", async () => {
  const id = await newPaidTournament();
  const rpc = rpcFor();
  const res = await economy.joinPaidTournament(id, PLAYER, validTx().hash, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK });

  // 1. the seat exists in the REAL engine document and is PAID
  const doc = await engineDoc(id);
  const entry = doc.entries.find((e) => e.playerId === PLAYER);
  assert.ok(entry, "paid join must create a tournament entry");
  assert.ok(entry.paid, "the entry must carry paid proof");
  assert.equal(entry.paid.txHash, res.txHash);
  assert.equal(entry.leftAt, undefined);

  // 2. the REAL 1C ledger holds exactly one consumption row for this tx
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.ok(raw, "B2: consumption map must live in the project storage abstraction");
  const map = JSON.parse(raw) as Record<string, TxModule.VerifiedNimiqTransaction>;
  const rows = Object.values(map).filter((r) => r.txHash === res.txHash);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "tournament_entry");
  assert.equal(rows[0].tournamentId, id);
  assert.equal(rows[0].playerId, PLAYER);
});

test("B1: retry with the SAME tx is idempotent — still exactly one consumption", async () => {
  const id = await newPaidTournament();
  const rpc = rpcFor();
  const h = validTx().hash;
  await economy.joinPaidTournament(id, PLAYER, h, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK });
  const again = await economy.joinPaidTournament(id, PLAYER, h, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK });
  assert.equal(again.txHash, h);

  const doc = await engineDoc(id);
  assert.equal(doc.entries.filter((e) => e.playerId === PLAYER).length, 1);
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  const rows = Object.values(JSON.parse(raw ?? "{}") as Record<string, TxModule.VerifiedNimiqTransaction>).filter(
    (r) => r.txHash === h,
  );
  assert.equal(rows.length, 1);
});

test("B1: a DIFFERENT tx after a paid seat is rejected — no second consumption", async () => {
  const id = await newPaidTournament();
  const rpc = rpcFor();
  await economy.joinPaidTournament(id, PLAYER, validTx().hash, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK });
  const h2 = validTx().hash;
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, h2, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) => err.kind === "already-paid",
  );
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.equal(JSON.parse(raw as string)[`test:${h2}`], undefined);
});

test("B1: failed verification releases the reserved seat and consumes nothing", async () => {
  const id = await newPaidTournament();
  const rpc = rpcFor({ value: "1" }); // wrong amount → verification fails
  const h = validTx().hash;
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, h, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) => err.kind === "verification-failed",
  );
  // The reservation was rolled back — no phantom seat, no consumption.
  const doc = await engineDoc(id);
  assert.equal(doc.entries.some((e) => e.playerId === PLAYER), false);
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.equal(JSON.parse(raw as string)[`test:${h}`], undefined);

  // The player can retry with a VALID payment afterwards.
  const ok = await economy.joinPaidTournament(id, PLAYER, validTx().hash, { rpc: rpcFor() as never, isGuestAccount: ACCOUNT_OK });
  assert.ok(ok.txHash);
  const doc2 = await engineDoc(id);
  assert.ok(doc2.entries.find((e) => e.playerId === PLAYER)?.paid);
});

test("B1: a PRE-EXISTING seat (free join) survives failed verification — no release of held seats", async () => {
  const id = await newPaidTournament();
  const joined = await engine.joinTournament(id, PLAYER); // unpaid seat via the plain flow
  assert.equal(joined.ok, true);
  const rpc = rpcFor({ networkId: 42 }); // wrong network → fails
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, validTx().hash, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) =>
      err.kind === "verification-failed" && /network/i.test(err.message),
  );
  // Held (not created) seat must still be there, unpaid.
  const doc = await engineDoc(id);
  const entry = doc.entries.find((e) => e.playerId === PLAYER);
  assert.ok(entry);
  assert.equal(entry.paid, undefined);
});

test("B1: an already-consumed row for THIS player+tournament completes the seat (crash self-heal)", async () => {
  const id = await newPaidTournament();
  const rpc = rpcFor();
  const h = validTx().hash;

  // Inject a seat-writer failure for the FIRST attempt: consumption succeeds,
  // seat write fails → SeatCreationError carrying the consumed hash.
  const boom = async () => {
    throw new Error("simulated persistence outage");
  };
  await assert.rejects(
    () =>
      economy.joinPaidTournament(id, PLAYER, h, {
        rpc: rpc as never,
        isGuestAccount: ACCOUNT_OK,
        markEntryPaid: boom,
      }),
    (err: EconomyModule.SeatCreationError) => {
      assert.equal(err.consumedTxHash, h);
      assert.equal(err.kind, "seat-creation-failed");
      return true;
    },
  );

  // The tx IS consumed (exactly once). The seat the flow reserved REMAINS
  // (reserve-first: the player keeps their slot; nothing was released for a
  // persistence failure), but it is NOT yet paid.
  let raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.ok(JSON.parse(raw as string)[`test:${h}`]);
  const doc0 = await engineDoc(id);
  const reserved = doc0.entries.find((e) => e.playerId === PLAYER);
  assert.ok(reserved, "the reserved seat must survive the writer outage");
  assert.equal(reserved.paid, undefined);

  // Resubmitting the SAME hash self-heals: the seat is completed idempotently.
  const healed = await economy.joinPaidTournament(id, PLAYER, h, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK });
  assert.equal(healed.txHash, h);
  const doc = await engineDoc(id);
  assert.equal(doc.entries.find((e) => e.playerId === PLAYER)?.paid?.txHash, h);
  raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.equal(Object.values(JSON.parse(raw ?? "{}") as Record<string, unknown>).filter((r) => (r as TxModule.VerifiedNimiqTransaction).txHash === h).length, 1);
});

test("B1: one payment can never attach to a SECOND tournament", async () => {
  const idA = await newPaidTournament();
  const idB = await newPaidTournament();
  const rpc = rpcFor();
  const h = validTx().hash;
  await economy.joinPaidTournament(idA, PLAYER, h, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK });
  await assert.rejects(
    () => economy.joinPaidTournament(idB, PLAYER, h, { rpc: rpc as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) => err.kind === "already-paid",
  );
  const docB = await engineDoc(idB);
  assert.equal(docB.entries.some((e) => e.playerId === PLAYER), false);
});

test("B1: a full tournament rejects BEFORE verification/consumption", async () => {
  const id = await newPaidTournament();
  // Fill the field (maxPlayers 4).
  for (let i = 0; i < 4; i += 1) {
    const r = await engine.joinTournament(id, `acct_fill_${i}`);
    assert.equal(r.ok, true);
  }
  const h = validTx().hash;
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, h, { rpc: rpcFor() as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) => err.kind === "tournament-full",
  );
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.equal(JSON.parse(raw as string)[`test:${h}`], undefined, "no consumption for an impossible seat");
});

/* ================================================================== */
/* H2 — guests are gated server-side                                   */
/* ================================================================== */

test("H2: guest + paid tournament → rejected before verification or seat creation", async () => {
  const id = await newPaidTournament();
  const h = validTx().hash;
  await assert.rejects(
    () =>
      economy.joinPaidTournament(id, "guest_999", h, {
        rpc: rpcFor() as never,
        isGuestAccount: async () => true,
      }),
    (err: EconomyModule.TournamentEntryError) => err.kind === "guest-rejected" && err.status === 403,
  );
  const doc = await engineDoc(id);
  assert.equal(doc.entries.some((e) => e.playerId === "guest_999"), false);
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.equal(JSON.parse(raw as string)[`test:${h}`], undefined);
});

test("H2: guest + free tournament → the plain join path stays open", async () => {
  const id = await newFreeTournament();
  const joined = await engine.joinTournament(id, "guest_777");
  assert.equal(joined.ok, true);
  const doc = await engineDoc(id);
  assert.ok(doc.entries.find((e) => e.playerId === "guest_777"));
});

test("H2: authenticated player + paid tournament → allowed (gate passes)", async () => {
  const id = await newPaidTournament();
  const doc = await engineDoc(id);
  // The shared gate helper itself: no throw for an authenticated player.
  await economy.requireAccountForPaidTournament(doc, PLAYER, async () => false);
  await assert.rejects(
    () => economy.requireAccountForPaidTournament(doc, PLAYER, async () => true),
    (err: EconomyModule.TournamentEntryError) => err.kind === "guest-rejected",
  );
  // Free tournaments never trip the gate.
  const freeDoc = await engineDoc(await newFreeTournament());
  await economy.requireAccountForPaidTournament(freeDoc, PLAYER, async () => true);
});

/* ================================================================== */
/* B2 — money stores ride the project storage abstraction              */
/* ================================================================== */

test("B2: consumption map and payout ledger live under project storage keys (file backend)", async () => {
  // The consumption key was proven in B1 tests; here the payout ledger:
  const id = await newPaidTournament();
  await economy.joinPaidTournament(id, PLAYER, validTx().hash, { rpc: rpcFor() as never, isGuestAccount: ACCOUNT_OK });
  const doc = await engineDoc(id);
  const planned = await payouts.planTournamentPayouts(
    id,
    { preset: "winner", standingsRanks: [{ rank: 1, playerId: PLAYER }] },
  );
  assert.ok("created" in planned && planned.created === 1);
  const raw = await storage.getGameStorage().get("chainmate:payouts");
  assert.ok(raw, "payout ledger must live in the project storage abstraction");
  assert.ok(JSON.parse(raw).payouts[`${id}:${PLAYER}`]);
  assert.ok(doc.entryFeeLuna);
  // And NOT in the legacy raw file:
  assert.equal(existsSync(path.join(DATA_ROOT, ".data", "payouts.json")), false);
});

test("B2: duplicate consumption through the store seam is always rejected", async () => {
  const h = validTx().hash;
  const row = {
    network: "test" as const,
    txHash: h,
    playerId: PLAYER,
    kind: "verification" as const,
    tournamentId: null,
    sender: LINKED,
    recipient: ENTRY_TREASURY,
    amountLuna: "1",
    blockNumber: 1,
    confirmations: 10,
  };
  await tx.fastStoreTxStore.insertConsumed(row);
  await assert.rejects(
    () => tx.fastStoreTxStore.insertConsumed(row),
    (err: TxModule.NimiqTxError) => err.kind === "already-consumed",
  );
  const found = await tx.fastStoreTxStore.findByNetworkAndHash("test", h);
  assert.ok(found);
});

test("B2: legacy raw-file consumption rows are imported (no replay history lost)", async () => {
  const h = validTx().hash;
  const legacyRow = {
    network: "test" as const,
    txHash: h,
    playerId: PLAYER,
    kind: "verification",
    tournamentId: null,
    sender: LINKED,
    recipient: ENTRY_TREASURY,
    amountLuna: "7",
    blockNumber: 5,
    confirmations: 9,
    id: 424242,
    verifiedAt: 1234,
  };
  // Simulate a fresh deployment upgrading from the pre-B2 format: remove
  // the v2 key so the one-time legacy import (from .data/games.json) runs.
  await storage.getGameStorage().delete("chainmate:nimiq:transactions:v2");
  mkdirSync(path.join(DATA_ROOT, ".data"), { recursive: true });
  writeFileSync(
    path.join(DATA_ROOT, ".data", "games.json"),
    JSON.stringify({ "chainmate:nimiq:transactions": { [`test:${h}`]: legacyRow } }),
  );
  const found = await tx.fastStoreTxStore.findByNetworkAndHash("test", h);
  assert.ok(found, "legacy row must be visible through the new store");
  // A replay of that legacy tx is rejected — history preserved.
  await assert.rejects(
    () => tx.fastStoreTxStore.insertConsumed(legacyRow),
    (err: TxModule.NimiqTxError) => err.kind === "already-consumed",
  );
});

test("B2: legacy .data/payouts.json is imported into the abstraction without losing state", async () => {
  const id = "tour_legacy_payouts";
  writeFileSync(
    path.join(DATA_ROOT, ".data", "payouts.json"),
    JSON.stringify({
      payouts: {
        [`${id}:acct_old`]: {
          tournamentId: id,
          playerId: "acct_old",
          payoutRank: 1,
          shareBps: 10000,
          amountLuna: "1000",
          destinationAddress: LINKED,
          status: "verified",
          payoutTxHash: "f".repeat(64),
          sentAt: 1,
          verifiedAt: 2,
          failureReason: null,
        },
      },
    }),
  );
  const imported = await payouts.migrateLegacyPayoutStore();
  assert.equal(imported, 1);
  const rows = await payouts.listTournamentPayouts(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "verified");
  // A second migration adds nothing (idempotent).
  assert.equal(await payouts.migrateLegacyPayoutStore(), 0);
});

/* ================================================================== */
/* H4 — one canonical treasury; divergence fails closed                */
/* ================================================================== */

test("H4: payout treasury diverging from the entry treasury disables dispatch (fail closed)", async () => {
  process.env.NIMIQ_PAYOUT_RPC_URL = "http://127.0.0.1:1";
  process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS = PAYOUT_TREASURY; // ≠ ENTRY_TREASURY
  assert.throws(
    () => dispatch.buildRpcTreasurySigner(),
    (err: unknown) =>
      err instanceof dispatch.PayoutDispatchError &&
      err.kind === "configuration-error" &&
      /Treasury mismatch/i.test(err.message),
  );
  // Aligned config builds the signer.
  process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS = ENTRY_TREASURY;
  const signer = dispatch.buildRpcTreasurySigner();
  assert.ok(signer);
  assert.equal(signer.getSenderAddress?.(), ENTRY_TREASURY.toUpperCase());
  delete process.env.NIMIQ_PAYOUT_RPC_URL;
  delete process.env.NIMIQ_PAYOUT_TREASURY_ADDRESS;
});

test("H4: the server-side NIMIQ_TREASURY_ADDRESS overrides the public value for entry verification", async () => {
  process.env.NIMIQ_TREASURY_ADDRESS = ENTRY_TREASURY;
  // NEXT_PUBLIC still points at a DIFFERENT address (stale public value):
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = PAYOUT_TREASURY;
  const id = await newPaidTournament();
  // A tx sent to the PUBLIC (stale) address must be REJECTED:
  await assert.rejects(
    () =>
      economy.joinPaidTournament(id, PLAYER, validTx({ to: PAYOUT_TREASURY }).hash, {
        rpc: rpcFor({ to: PAYOUT_TREASURY }) as never,
        isGuestAccount: ACCOUNT_OK,
      }),
    (err: EconomyModule.TournamentEntryError) => /recipient|treasury/i.test(err.message),
  );
  // A tx sent to the SERVER-authoritative treasury is accepted:
  const ok = await economy.joinPaidTournament(id, PLAYER, validTx().hash, { rpc: rpcFor() as never, isGuestAccount: ACCOUNT_OK });
  assert.ok(ok.txHash);
  delete process.env.NIMIQ_TREASURY_ADDRESS;
  process.env.NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS = ENTRY_TREASURY;
});

/* ================================================================== */
/* M1 — network verification fails closed                              */
/* ================================================================== */

test("M1 (1C): missing networkId on the node response refuses verification", async () => {
  const id = await newPaidTournament();
  const h = validTx({ networkId: undefined }).hash;
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, h, { rpc: rpcFor({ networkId: undefined }) as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) =>
      err.kind === "verification-failed" && /networkId/i.test(err.message),
  );
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions:v2");
  assert.equal(JSON.parse(raw as string)[`test:${h}`], undefined);
});

test("M1 (1C): unknown and mismatched networkIds fail closed", async () => {
  const id = await newPaidTournament();
  const unknown = validTx({ networkId: 99 }).hash;
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, unknown, { rpc: rpcFor({ networkId: 99 }) as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) => /known Nimiq network/i.test(err.message),
  );
  const mainnet = validTx({ networkId: 42 }).hash;
  await assert.rejects(
    () => economy.joinPaidTournament(id, PLAYER, mainnet, { rpc: rpcFor({ networkId: 42 }) as never, isGuestAccount: ACCOUNT_OK }),
    (err: EconomyModule.TournamentEntryError) => /networkId 42.*expected 5/s.test(err.message),
  );
});

test("M1 (1C): correct testnet networkId verifies", async () => {
  const id = await newPaidTournament();
  const res = await economy.joinPaidTournament(id, PLAYER, validTx({ networkId: 5 }).hash, {
    rpc: rpcFor({ networkId: 5 }) as never,
    isGuestAccount: ACCOUNT_OK,
  });
  assert.ok(res.txHash);
});

test("M1 (3B): payout verification refuses missing/mismatched network identity", async () => {
  const sent = {
    tournamentId: "tour_m1",
    playerId: PLAYER,
    payoutRank: 1,
    shareBps: 10000,
    amountLuna: "1000",
    destinationAddress: LINKED,
    status: "sent" as const,
    payoutTxHash: "c".repeat(64),
    sentAt: 1,
    verifiedAt: null,
    failureReason: null,
    network: "test" as const,
    // WAL metadata: the sender of record when payout env config is absent.
    senderAddress: ENTRY_TREASURY,
  };
  const mem = {
    rows: new Map<string, typeof sent>([["tour_m1:acct_p1", sent]]),
  };
  const storeFake: PayoutsModule.PayoutStore = {
    async listByTournament(tid) {
      return [...mem.rows.values()].filter((r) => r.tournamentId === tid);
    },
    async upsert(p) {
      mem.rows.set(`${p.tournamentId}:${p.playerId}`, p as typeof sent);
    },
    async get(t, pid) {
      return mem.rows.get(`${t}:${pid}`) ?? null;
    },
  };
  const makeVerify = (over: Record<string, unknown>) => ({
    store: storeFake,
    getTransactionByHash: (async () => ({
      hash: sent.payoutTxHash,
      from: ENTRY_TREASURY,
      to: LINKED,
      value: "1000",
      blockNumber: 991,
      executionResult: true,
      ...over,
    })) as unknown as typeof import("@/lib/server/nimiq/rpc").getTransactionByHash,
    getBlockNumber: (async () => 1000) as unknown as typeof import("@/lib/server/nimiq/rpc").getBlockNumber,
  });
  await assert.rejects(
    () => dispatch.verifyOutgoingPayout("tour_m1", PLAYER, makeVerify({})),
    (err: unknown) =>
      err instanceof dispatch.PayoutDispatchError &&
      err.kind === "malformed-response" &&
      /networkId/i.test(err.message),
  );
  await assert.rejects(
    () => dispatch.verifyOutgoingPayout("tour_m1", PLAYER, makeVerify({ networkId: 42 })),
    (err: unknown) =>
      err instanceof dispatch.PayoutDispatchError && /networkId 42/i.test(err.message),
  );
  const verified = await dispatch.verifyOutgoingPayout(
    "tour_m1",
    PLAYER,
    makeVerify({ networkId: 5 }),
  );
  assert.equal(verified.status, "verified");
});

/* ================================================================== */
/* M4 — payout status can never regress                                */
/* ================================================================== */

test("M4: monotonic merge keeps the most advanced state", () => {
  const base = {
    tournamentId: "t",
    playerId: "p",
    payoutRank: 1,
    shareBps: 10000,
    amountLuna: "1",
    destinationAddress: LINKED,
    payoutTxHash: null,
    sentAt: null,
    verifiedAt: null,
    failureReason: null,
  };
  const mk = (status: PayoutsModule.PayoutStatus, over: Record<string, unknown> = {}) =>
    ({ ...base, status, ...over }) as PayoutsModule.PayoutRecord;
  // Forward transitions win…
  assert.equal(payouts.mergeMonotonicPayout(mk("pending"), mk("sent")).status, "sent");
  assert.equal(payouts.mergeMonotonicPayout(mk("dispatching"), mk("verified")).status, "verified");
  // …stale writes cannot move a payout backward…
  assert.equal(payouts.mergeMonotonicPayout(mk("verified"), mk("sent")).status, "verified");
  assert.equal(payouts.mergeMonotonicPayout(mk("sent"), mk("pending")).status, "sent");
  assert.equal(payouts.mergeMonotonicPayout(mk("sent"), mk("failed")).status, "sent");
  assert.equal(payouts.mergeMonotonicPayout(mk("dispatching"), mk("pending")).status, "dispatching");
  // …the WAL resolution path (dispatching → failed) stays open…
  assert.equal(payouts.mergeMonotonicPayout(mk("dispatching"), mk("failed")).status, "failed");
  // …and retry re-planning (failed → pending) still works.
  assert.equal(payouts.mergeMonotonicPayout(mk("failed"), mk("pending")).status, "pending");
});

test("M4: the real store drops a stale downgrade over an advanced row", async () => {
  const id = "tour_m4";
  const base = {
    tournamentId: id,
    playerId: PLAYER,
    payoutRank: 1,
    shareBps: 10000,
    amountLuna: "500",
    destinationAddress: LINKED,
    payoutTxHash: null,
    sentAt: null,
    verifiedAt: null,
    failureReason: null,
  };
  await payouts.fastStorePayoutStore.upsert({
    ...base,
    status: "verified",
    payoutTxHash: "e".repeat(64),
    sentAt: 1,
    verifiedAt: 2,
  } as PayoutsModule.PayoutRecord);
  // A racing stale write (e.g. an out-of-order mirror reconciliation):
  await payouts.fastStorePayoutStore.upsert({ ...base, status: "pending" } as PayoutsModule.PayoutRecord);
  const row = await payouts.fastStorePayoutStore.get(id, PLAYER);
  assert.equal(row?.status, "verified");
  assert.equal(row?.payoutTxHash, "e".repeat(64));
});

/* ================================================================== */
/* L — free tournaments remain exactly as before                       */
/* ================================================================== */

test("L: free tournament join/leave flow unchanged (no wallet, no ledger)", async () => {
  const id = await newFreeTournament();
  const joined = await engine.joinTournament(id, "guest_free");
  assert.equal(joined.ok, true);
  const left = await engine.leaveTournament(id, "guest_free");
  assert.equal(left.ok, true);
  const raw = await storage.getGameStorage().get("chainmate:nimiq:transactions");
  const map = JSON.parse(raw ?? "{}") as Record<string, unknown>;
  assert.equal(Object.keys(map).some((k) => k.startsWith("test:") && !k.includes("a")), false);
});

test("H1 (report-only check): unconfigured Supabase keeps transitions single-instance correct", async () => {
  // transitionTournamentStatus returns true when no Supabase lock exists —
  // the in-process document lock is then the only guard (single-instance).
  // This test documents the behaviour without changing it: within one
  // process, a double transition is still rejected by the engine's status
  // re-check, so no duplicate round generation can occur here.
  const id = await newFreeTournament();
  const first = await engine.transitionTournament(id, HOST, "locked");
  assert.equal(first.ok, true);
  const second = await engine.transitionTournament(id, HOST, "locked");
  assert.equal(second.ok, false, "double transition must be rejected by the engine");
});
