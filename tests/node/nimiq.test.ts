/**
 * Nimiq Phase 1A foundation tests.
 *
 * Covers the four foundation modules against real behavior:
 *  - format.ts: exact bigint luna math (the float-money traps)
 *  - config.ts: network ids, address shape, server RPC config parsing
 *  - miniapp.ts: ErrorResponse normalization + wire conversion, driven through
 *    fake provider objects that mimic the real SDK's union-return methods
 *  - rpc.ts: a REAL local JSON-RPC server (node:http) verifying positional
 *    params, Basic auth, timeouts, RPC error objects and all three methods
 *
 * No Nimiq network is contacted. Run: npm test
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";

import {
  LUNA_PER_NIM,
  NIM_DECIMALS,
  NimiqMoneyError,
  formatNim,
  formatNimFixed,
  parseNim,
  sumLuna,
  toLuna,
} from "@/lib/nimiq/format";
import {
  NIMIQ_NETWORK_IDS,
  getServerNimiqRpcConfig,
  isPlausibleNimiqAddress,
  nimiqNetworkId,
  nimiqNetworkName,
} from "@/lib/nimiq/config";
import {
  listNimiqAccounts,
  normalizeNimiqError,
  sendNimiqBasicTransaction,
  signNimiqMessage,
} from "@/lib/nimiq/miniapp";
import {
  NimiqRpcError,
  getAccountByAddress,
  getBlockNumber,
  getTransactionByHash,
  sendBasicTransaction,
} from "@/lib/server/nimiq/rpc";

/* ------------------------------------------------------------------ */
/* format.ts — exact money                                             */
/* ------------------------------------------------------------------ */

test("luna constants are exact", () => {
  assert.equal(LUNA_PER_NIM, 100_000n);
  assert.equal(NIM_DECIMALS, 5);
});

test("formatNim renders luna exactly", () => {
  assert.equal(formatNim(0n), "0");
  assert.equal(formatNim(1n), "0.00001");
  assert.equal(formatNim(123450n), "1.2345");
  assert.equal(formatNim(100_000n), "1");
  assert.equal(formatNim(1_234_567n), "12.34567");
  assert.equal(formatNim(-500n), "-0.005");
  assert.equal(formatNim("9007199254740993"), "90071992547.40993"); // beyond Number.MAX_SAFE_INTEGER
});

test("formatNimFixed keeps fixed decimals for tables", () => {
  assert.equal(formatNimFixed(123450n, 2), "1.23");
  assert.equal(formatNimFixed(100000n, 4), "1.0000");
  assert.equal(formatNimFixed(150n, 2), "0.00"); // display clip only
  assert.equal(formatNimFixed(0n, 0), "0");
});

test("parseNim is exact and rejects sub-luna precision", () => {
  assert.equal(parseNim("1.2345"), 123450n);
  assert.equal(parseNim("12.34"), 1_234_000n);
  assert.equal(parseNim(".5"), 50_000n);
  assert.equal(parseNim("12"), 1_200_000n);
  assert.equal(parseNim("1 234.5"), 123_450_000n); // thousands separator
  assert.equal(parseNim("-0.005"), -500n);
  assert.throws(() => parseNim("0.000001"), NimiqMoneyError); // 6th decimal
  assert.throws(() => parseNim("abc"), NimiqMoneyError);
  assert.throws(() => parseNim(""), NimiqMoneyError);
  assert.throws(() => parseNim("1.2.3"), NimiqMoneyError);
});

test("the classic float trap never happens: 0.1 + 0.2 === 0.3", () => {
  // In doubles: 0.1 + 0.2 = 0.30000000000000004. In luna it is exactly 30000.
  assert.equal(sumLuna([parseNim("0.1"), parseNim("0.2")]), 30_000n);
  assert.equal(formatNim(sumLuna([parseNim("0.1"), parseNim("0.2")])), "0.3");
});

test("sumLuna/toLuna accept JSON-shaped values (numbers and strings)", () => {
  assert.equal(toLuna("12345"), 12345n);
  assert.equal(toLuna(12345), 12345n); // safe integer
  assert.equal(toLuna(12345n), 12345n);
  assert.throws(() => toLuna(1.5), NimiqMoneyError); // fractional luna is a bug
  assert.throws(() => toLuna("12.5"), NimiqMoneyError);
  assert.equal(sumLuna(["100", 50, 25n]), 175n);
});

/* ------------------------------------------------------------------ */
/* config.ts — networks, addresses, server config                      */
/* ------------------------------------------------------------------ */

test("network names map to the fixed protocol ids (42 main, 5 test)", () => {
  assert.deepEqual(NIMIQ_NETWORK_IDS, { main: 42, test: 5 });
  assert.equal(nimiqNetworkId("main"), 42);
  assert.equal(nimiqNetworkId("test"), 5);
  assert.equal(nimiqNetworkName("main"), "main");
  assert.equal(nimiqNetworkName("mainnet"), "main");
  assert.equal(nimiqNetworkName("test"), "test");
  assert.equal(nimiqNetworkName("testnet"), "test"); // documented alias
  // Defaults must never point money code at mainnet by accident:
  assert.equal(nimiqNetworkName(undefined), "test");
  assert.equal(nimiqNetworkName(""), "test");
  assert.equal(nimiqNetworkName("garbage"), "test");
  assert.equal(nimiqNetworkId(nimiqNetworkName(undefined)), 5);
});

test("isPlausibleNimiqAddress accepts NQ addresses in common spellings", () => {
  assert.ok(isPlausibleNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000"));
  assert.ok(isPlausibleNimiqAddress("NQ07XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"));
  assert.ok(!isPlausibleNimiqAddress("0x1234"));
  assert.ok(!isPlausibleNimiqAddress("NQ07"));
  assert.ok(!isPlausibleNimiqAddress(""));
  assert.ok(!isPlausibleNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 000"));
});

test("getServerNimiqRpcConfig reads env lazily and has NO public default", () => {
  const savedUrl = process.env.NIMIQ_RPC_URL;
  const savedAuth = process.env.NIMIQ_RPC_BASIC_AUTH;
  const savedConf = process.env.NIMIQ_CONFIRMATIONS_REQUIRED;
  try {
    delete process.env.NIMIQ_RPC_URL;
    assert.equal(getServerNimiqRpcConfig(), null, "no URL configured → null, never a guessed endpoint");

    process.env.NIMIQ_RPC_URL = "http://127.0.0.1:8648";
    delete process.env.NIMIQ_RPC_BASIC_AUTH;
    delete process.env.NIMIQ_CONFIRMATIONS_REQUIRED;
    let cfg = getServerNimiqRpcConfig();
    assert.ok(cfg);
    assert.equal(cfg.url, "http://127.0.0.1:8648");
    assert.equal(cfg.basicAuth, null);
    assert.equal(cfg.confirmationsRequired, 10, "sane default confirmations");

    process.env.NIMIQ_RPC_BASIC_AUTH = "user:secret";
    process.env.NIMIQ_CONFIRMATIONS_REQUIRED = "3";
    cfg = getServerNimiqRpcConfig();
    assert.equal(cfg?.basicAuth, "user:secret");
    assert.equal(cfg?.confirmationsRequired, 3);

    process.env.NIMIQ_CONFIRMATIONS_REQUIRED = "not-a-number";
    assert.equal(getServerNimiqRpcConfig()?.confirmationsRequired, 10);
  } finally {
    if (savedUrl === undefined) delete process.env.NIMIQ_RPC_URL;
    else process.env.NIMIQ_RPC_URL = savedUrl;
    if (savedAuth === undefined) delete process.env.NIMIQ_RPC_BASIC_AUTH;
    else process.env.NIMIQ_RPC_BASIC_AUTH = savedAuth;
    if (savedConf === undefined) delete process.env.NIMIQ_CONFIRMATIONS_REQUIRED;
    else process.env.NIMIQ_CONFIRMATIONS_REQUIRED = savedConf;
  }
});

/* ------------------------------------------------------------------ */
/* miniapp.ts — normalization over the real SDK's union results        */
/* ------------------------------------------------------------------ */

type Provider = Awaited<ReturnType<(typeof import("@nimiq/mini-app-sdk"))["init"]>>;

/** Minimal fake of NimiqProvider's wallet methods (union-return signatures). */
function fakeProvider(overrides: {
  listAccounts?: () => Promise<string[] | { error: { type: string; message: string } }>;
  sign?: (m: unknown) => Promise<{ publicKey: string; signature: string } | { error: { type: string; message: string } }>;
  sendBasicTransaction?: (tx: unknown) => Promise<string | { error: { type: string; message: string } }>;
}): Provider {
  return {
    listAccounts: overrides.listAccounts ?? (async () => []),
    sign: overrides.sign ?? (async () => ({ publicKey: "pk", signature: "sig" })),
    sendBasicTransaction: overrides.sendBasicTransaction ?? (async () => "hash"),
  } as unknown as Provider;
}

test("listNimiqAccounts returns accounts and normalizes ErrorResponse", async () => {
  const ok = await listNimiqAccounts(fakeProvider({}));
  assert.deepEqual(ok, { ok: true, value: [] });

  const accounts = await listNimiqAccounts(
    fakeProvider({ listAccounts: async () => ["NQ07 AAA", "NQ08 BBB"] }),
  );
  assert.deepEqual(accounts, { ok: true, value: ["NQ07 AAA", "NQ08 BBB"] });

  const rejected = await listNimiqAccounts(
    fakeProvider({
      listAccounts: async () => ({ error: { type: "USER_REJECTION", message: "User denied" } }),
    }),
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.kind, "user-rejected");
});

test("signNimiqMessage surfaces SignatureResult or a typed error", async () => {
  const ok = await signNimiqMessage(fakeProvider({}), "hello");
  assert.ok(ok.ok && ok.value.signature === "sig");

  const err = await signNimiqMessage(
    fakeProvider({
      sign: async () => ({ error: { type: "PROVIDER", message: "Request timed out" } }),
    }),
    "hello",
  );
  assert.equal(err.ok, false);
  if (!err.ok) assert.equal(err.error.kind, "timeout");
});

test("sendNimiqBasicTransaction converts bigint luna to the SDK's number wire type", async () => {
  let captured: unknown;
  const provider = fakeProvider({
    sendBasicTransaction: async (tx) => {
      captured = tx;
      return "txhash123";
    },
  });
  const result = await sendNimiqBasicTransaction(provider, {
    recipient: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
    value: 1_500_000n,
    fee: 138n,
  });
  assert.ok(result.ok && result.value === "txhash123");
  assert.deepEqual(captured, {
    recipient: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
    value: 1_500_000, // exact as a number — luna values stay far below 2^53
    fee: 138,
  });
});

test("normalizeNimiqError maps thrown SDK errors", () => {
  assert.deepEqual(normalizeNimiqError(new Error("Nimiq provider was not injected. Are you running inside a Nimiq app?")), {
    kind: "provider",
    message: "Nimiq provider was not injected. Are you running inside a Nimiq app?",
  });
  assert.equal(normalizeNimiqError({ error: { type: "WALLET", message: "User rejected the request" } }).kind, "user-rejected");
  assert.equal(normalizeNimiqError({ error: { type: "", message: "odd failure" } }).kind, "provider");
  assert.equal(normalizeNimiqError("boom").kind, "unknown");
});

/* ------------------------------------------------------------------ */
/* rpc.ts — real JSON-RPC over a local HTTP server                     */
/* ------------------------------------------------------------------ */

let server: Server;
let serverUrl = "";
let lastAuthHeader: string | null = null;
let lastBody: { method: string; params: unknown } | null = null;
let responseMode: "ok" | "rpc-error" | "http-500" | "slow" | "garbage" = "ok";
before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastAuthHeader = req.headers.authorization ?? null;
      const parsed = JSON.parse(raw) as { method: string; params: unknown };
      lastBody = { method: parsed.method, params: parsed.params };
      const respond = (payload: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (responseMode === "http-500") return respond({ error: "nope" }, 500);
      if (responseMode === "garbage") return respond(undefined, 200); // body null after parse
      if (responseMode === "rpc-error")
        return respond({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
      if (responseMode === "slow") {
        setTimeout(() => respond({ jsonrpc: "2.0", id: 1, result: 1 }), 300);
        return;
      }
      // Echo a sensible result per method.
      let result: unknown = null;
      if (parsed.method === "getBlockNumber") result = 1_234_567;
      else if (parsed.method === "getAccountByAddress")
        result = { address: (parsed.params as string[])[0], balance: "1500000" };
      else if (parsed.method === "getTransactionByHash")
        result = { hash: (parsed.params as string[])[0], from: "NQ07 F", to: "NQ07 T", value: "100000" };
      else if (parsed.method === "sendBasicTransaction") result = "f".repeat(64);
      respond({ jsonrpc: "2.0", id: 1, result });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("getBlockNumber sends positional empty params and returns the number", async () => {
  const height = await getBlockNumber({ url: serverUrl, timeoutMs: 2_000 });
  assert.equal(height, 1_234_567);
  assert.equal(lastBody?.method, "getBlockNumber");
  assert.deepEqual(lastBody?.params, []);
});

test("getAccountByAddress sends [address] positionally and maps the account", async () => {
  const account = await getAccountByAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000", {
    url: serverUrl,
    timeoutMs: 2_000,
  });
  assert.ok(account);
  assert.equal(account.balance, "1500000"); // string luna passed through for exact bigint handling
  assert.deepEqual(lastBody?.params, ["NQ07 0000 0000 0000 0000 0000 0000 0000 0000"]);
});

test("getTransactionByHash sends [hash] positionally and maps the transaction", async () => {
  const tx = await getTransactionByHash("abc123", { url: serverUrl, timeoutMs: 2_000 });
  assert.ok(tx);
  assert.equal(tx.hash, "abc123");
  assert.deepEqual(lastBody?.params, ["abc123"]);
});

test("HTTP Basic auth is attached when configured", async () => {
  await getBlockNumber({ url: serverUrl, basicAuth: "user:pw", timeoutMs: 2_000 });
  assert.equal(lastAuthHeader, `Basic ${Buffer.from("user:pw").toString("base64")}`);

  await getBlockNumber({ url: serverUrl, basicAuth: null, timeoutMs: 2_000 });
  assert.equal(lastAuthHeader, null, "explicit null clears the header");
});

test("RPC error objects become NimiqRpcError with the code", async () => {
  responseMode = "rpc-error";
  try {
    await assert.rejects(
      () => getBlockNumber({ url: serverUrl, timeoutMs: 2_000 }),
      (err: unknown) => err instanceof NimiqRpcError && err.code === -32601 && /Method not found/.test(err.message),
    );
  } finally {
    responseMode = "ok";
  }
});

test("HTTP 500 and unparseable bodies become NimiqRpcError", async () => {
  responseMode = "http-500";
  try {
    await assert.rejects(
      () => getBlockNumber({ url: serverUrl, timeoutMs: 2_000 }),
      (err: unknown) => err instanceof NimiqRpcError && /HTTP 500/.test(err.message),
    );
  } finally {
    responseMode = "ok";
  }
});

test("a slow node triggers the timeout", async () => {
  responseMode = "slow";
  try {
    await assert.rejects(
      () => getBlockNumber({ url: serverUrl, timeoutMs: 100 }),
      (err: unknown) => err instanceof NimiqRpcError && /timed out/.test(err.message),
    );
  } finally {
    responseMode = "ok";
  }
});

test("with no URL anywhere the client refuses rather than guessing an endpoint", async () => {
  const saved = process.env.NIMIQ_RPC_URL;
  delete process.env.NIMIQ_RPC_URL;
  try {
    await assert.rejects(
      () => getBlockNumber(),
      (err: unknown) => err instanceof NimiqRpcError && /NIMIQ_RPC_URL is not configured/.test(err.message),
    );
  } finally {
    if (saved === undefined) delete process.env.NIMIQ_RPC_URL;
    else process.env.NIMIQ_RPC_URL = saved;
  }
});

/* ------------------------------------------------------------------ */
/* sendBasicTransaction — bigint → JSON-number wire conversion          */
/* ------------------------------------------------------------------ */

test("sendBasicTransaction serializes exact luna bigints as JSON numbers positionally", async () => {
  const hash = await sendBasicTransaction(
    "NQ07 SENDER 0000 0000 0000 0000 0000 0000 0000 00",
    "NQ07 RECIPI 0000 0000 0000 0000 0000 0000 0000 00",
    1_500_000n,
    138n,
    123_456,
    { url: serverUrl, timeoutMs: 2_000 },
  );
  assert.equal(hash, "f".repeat(64));
  // The wire params must be numbers — JSON has no bigint — and the order
  // must remain positional: [wallet, recipient, value, fee, vsh].
  assert.equal(lastBody?.method, "sendBasicTransaction");
  const params = lastBody?.params as unknown[];
  assert.equal(typeof params[2], "number");
  assert.equal(params[2], 1_500_000);
  assert.equal(typeof params[3], "number");
  assert.equal(params[3], 138);
  assert.equal(params[4], 123_456);
});

test("sendBasicTransaction rejects unsafe luna values BEFORE any RPC request", async () => {
  lastBody = null;
  const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n; // 2^53 — beyond the node's Coin range
  await assert.rejects(
    () =>
      sendBasicTransaction(
        "NQ07 SENDER 0000 0000 0000 0000 0000 0000 0000 00",
        "NQ07 RECIPI 0000 0000 0000 0000 0000 0000 0000 00",
        unsafe,
        0n,
        1,
        { url: serverUrl, timeoutMs: 2_000 },
      ),
    (err: unknown) =>
      err instanceof NimiqRpcError && /exceeds the JSON-safe integer range/.test(err.message),
  );
  await assert.rejects(
    () =>
      sendBasicTransaction(
        "NQ07 SENDER 0000 0000 0000 0000 0000 0000 0000 00",
        "NQ07 RECIPI 0000 0000 0000 0000 0000 0000 0000 00",
        1n,
        unsafe,
        1,
        { url: serverUrl, timeoutMs: 2_000 },
      ),
    (err: unknown) => err instanceof NimiqRpcError && /Transaction fee/.test(err.message),
  );
  // Nothing reached the wire — the guard fires before the HTTP request.
  assert.equal(lastBody, null);
});

test("sendBasicTransaction rejects negative luna and invalid vsh before RPC", async () => {
  lastBody = null;
  await assert.rejects(
    () =>
      sendBasicTransaction(
        "NQ07 S",
        "NQ07 R",
        -1n,
        0n,
        1,
        { url: serverUrl, timeoutMs: 2_000 },
      ),
    (err: unknown) => err instanceof NimiqRpcError && /Transaction value must be non-negative/.test(err.message),
  );
  await assert.rejects(
    () =>
      sendBasicTransaction(
        "NQ07 S",
        "NQ07 R",
        1n,
        0n,
        1.5,
        { url: serverUrl, timeoutMs: 2_000 },
      ),
    (err: unknown) => err instanceof NimiqRpcError && /validityStartHeight/.test(err.message),
  );
  assert.equal(lastBody, null);
});

test("no bigint value ever reaches JSON.stringify (the exact pre-fix failure)", async () => {
  // Pre-fix, this call threw 'Do not know how to serialize a BigInt' inside
  // rpcCall. The wire conversion is proven by the happy path above; here we
  // pin the failure mode: a MAX_SAFE_INTEGER amount serializes cleanly and
  // the node stub answers, so the full path completes without a TypeError.
  const hash = await sendBasicTransaction(
    "NQ07 S",
    "NQ07 R",
    BigInt(Number.MAX_SAFE_INTEGER),
    0n,
    42,
    { url: serverUrl, timeoutMs: 2_000 },
  );
  assert.equal(hash, "f".repeat(64));
  const params = (lastBody?.params ?? null) as unknown[] | null;
  assert.equal(params?.[2], Number.MAX_SAFE_INTEGER);
});
