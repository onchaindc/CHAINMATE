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
  nimiqErrorMessage,
  nimiqPaymentFailureMessage,
  normalizeNimiqError,
  pickWalletAccount,
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
import { isNimiqEnabled } from "@/lib/nimiq/flag";
import { init as sdkInit } from "@nimiq/mini-app-sdk";
import {
  classifyProviderState,
  hasNimiqHost,
} from "@/hooks/use-nimiq";

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

test("network names map to the fixed protocol ids (24 MainAlbatross, 5 TestAlbatross)", () => {
  assert.deepEqual(NIMIQ_NETWORK_IDS, { main: 24, test: 5 });
  assert.equal(nimiqNetworkId("main"), 24);
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
  const savedKey = process.env.NIMIQ_RPC_API_KEY;
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
    assert.equal(cfg?.apiKey, null, "no API key configured → null");

    process.env.NIMIQ_RPC_API_KEY = " nownodes-key-123 ";
    cfg = getServerNimiqRpcConfig();
    assert.equal(cfg?.apiKey, "nownodes-key-123", "API key is trimmed");

    process.env.NIMIQ_CONFIRMATIONS_REQUIRED = "not-a-number";
    assert.equal(getServerNimiqRpcConfig()?.confirmationsRequired, 10);
  } finally {
    if (savedUrl === undefined) delete process.env.NIMIQ_RPC_URL;
    else process.env.NIMIQ_RPC_URL = savedUrl;
    if (savedAuth === undefined) delete process.env.NIMIQ_RPC_BASIC_AUTH;
    else process.env.NIMIQ_RPC_BASIC_AUTH = savedAuth;
    if (savedKey === undefined) delete process.env.NIMIQ_RPC_API_KEY;
    else process.env.NIMIQ_RPC_API_KEY = savedKey;
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
  sendBasicTransactionWithData?: (tx: unknown) => Promise<
    string | { error: { type: string; message: string } }
  >;
}): Provider {
  return {
    listAccounts: overrides.listAccounts ?? (async () => []),
    sign: overrides.sign ?? (async () => ({ publicKey: "pk", signature: "sig" })),
    sendBasicTransaction: overrides.sendBasicTransaction ?? (async () => "hash"),
    sendBasicTransactionWithData:
      overrides.sendBasicTransactionWithData ?? (async () => "hash-with-data"),
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

test("sendNimiqBasicTransaction falls back to a plain transfer when the data send fails at the wallet", async () => {
  // The observed live failure: Nimiq Pay's sheet resolves with this text and
  // NO tx hash — nothing is on-chain, so retrying without the data field is
  // safe (no double-pay risk). Every successful ChainMate payment has been a
  // plain transfer, which the server verifies through the legacy sender
  // rules when the proof is absent.
  const calls: string[] = [];
  const provider = fakeProvider({
    sendBasicTransactionWithData: async () => {
      calls.push("with-data");
      throw new Error(
        "Failed to send payment transaction: Transaction invalidated during transaction",
      );
    },
    sendBasicTransaction: async () => {
      calls.push("plain");
      return "plainhash";
    },
  });
  const result = await sendNimiqBasicTransaction(provider, {
    recipient: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
    value: 1_500_000n,
    data: "deadbeef",
  });
  assert.ok(result.ok && result.value === "plainhash");
  assert.deepEqual(calls, ["with-data", "plain"], "must retry as a plain transfer");
});

test("a user rejection of the proof-carrying send is NOT retried as a second sheet", async () => {
  // One reject stays one reject: falling back would pop another wallet
  // confirmation sheet for a payment the user already declined.
  const calls: string[] = [];
  const provider = fakeProvider({
    sendBasicTransactionWithData: async () => {
      calls.push("with-data");
      return { error: { type: "USER_REJECTION", message: "User rejected the request" } };
    },
    sendBasicTransaction: async () => {
      calls.push("plain");
      return "plainhash";
    },
  });
  const result = await sendNimiqBasicTransaction(provider, {
    recipient: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
    value: 1_500_000n,
    data: "deadbeef",
  });
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "user-rejected");
  assert.deepEqual(calls, ["with-data"], "no fallback after an explicit user rejection");
});

test("a data-free payment never touches sendBasicTransactionWithData", async () => {
  const calls: string[] = [];
  const provider = fakeProvider({
    sendBasicTransaction: async () => {
      calls.push("plain");
      return "plainhash";
    },
  });
  const result = await sendNimiqBasicTransaction(provider, {
    recipient: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000",
    value: 1_500_000n,
  });
  assert.ok(result.ok && result.value === "plainhash");
  assert.deepEqual(calls, ["plain"]);
});

test("thrown user rejections classify as user-rejected (same as ErrorResponse)", () => {
  const err = normalizeNimiqError(
    new Error("Failed to send payment transaction: User rejected the transaction"),
  );
  assert.equal(err.kind, "user-rejected");
  // And the pre-existing classifications are unchanged.
  assert.equal(normalizeNimiqError(new Error("boom")).kind, "unknown");
  assert.deepEqual(normalizeNimiqError(new Error("Nimiq provider was not injected. Are you running inside a Nimiq app?")), {
    kind: "provider",
    message: "Nimiq provider was not injected. Are you running inside a Nimiq app?",
  });
  assert.equal(normalizeNimiqError({ error: { type: "WALLET", message: "User rejected the request" } }).kind, "user-rejected");
  assert.equal(normalizeNimiqError({ error: { type: "", message: "odd failure" } }).kind, "provider");
});

/* ------------------------------------------------------------------ */
/* Error normalization — every shape the Nimiq host can produce        */
/* ------------------------------------------------------------------ */

test("normalizeNimiqError never yields '[object Object]' for any error shape", () => {
  const shapes: unknown[] = [
    new Error("plain failure"),
    new Error("[object Object]"), // SDK transport: new Error(structured payload)
    "boom",
    "",
    42,
    true,
    null,
    undefined,
    {},
    { error: "insufficient funds" }, // bare-string error variant
    { error: { message: "User rejected the request" } },
    { error: { type: "WALLET", message: "User rejected the request" } },
    { error: { code: -32000, message: "Account is locked" } }, // JSON-RPC style
    { error: { data: { reason: "fee too low" } } }, // structured data, no message
    { error: null },
    { error: 7 },
    { reason: "fee too low", code: 42 }, // raw thrown object
    { message: "direct message field" },
    { foo: "bar" },
  ];
  for (const shape of shapes) {
    const normalized = normalizeNimiqError(shape);
    assert.ok(normalized.message.length > 0, `empty message for: ${JSON.stringify(shape)}`);
    assert.ok(
      !normalized.message.includes("[object Object]"),
      `mangled message for ${JSON.stringify(shape)}: ${normalized.message}`,
    );
    assert.ok(
      ["timeout", "user-rejected", "provider", "no-accounts", "unknown"].includes(normalized.kind),
    );
  }
});

test("normalizeNimiqError extracts real messages from structured payloads", () => {
  // JSON-RPC style error with code + message.
  assert.deepEqual(normalizeNimiqError({ error: { code: -32000, message: "Account is locked" } }), {
    kind: "provider",
    message: "Account is locked",
  });
  // Structured data instead of message.
  assert.deepEqual(normalizeNimiqError({ error: { data: { reason: "fee too low" } } }), {
    kind: "provider",
    message: '{"reason":"fee too low"}',
  });
  // Bare-string error variant.
  assert.equal(
    normalizeNimiqError({ error: "insufficient funds" }).message,
    "The Nimiq wallet rejected the request: insufficient funds",
  );
  // Raw thrown object with a message field.
  assert.equal(normalizeNimiqError({ message: "direct message field" }).message, "direct message field");
  // Raw thrown object without one is serialized, not stringified.
  assert.equal(normalizeNimiqError({ reason: "fee too low" }).message, '{"reason":"fee too low"}');
  // An Error instance built around an object still surfaces the cause.
  const caused = new Error("[object Object]");
  (caused as { cause?: unknown }).cause = { error: { message: "insufficient balance" } };
  assert.equal(normalizeNimiqError(caused).message, "insufficient balance");
  // Truly empty input gets an honest default, not an empty string.
  assert.equal(normalizeNimiqError(undefined).message, "The Nimiq wallet request failed");
});

test("nimiqErrorMessage prefixes payment failures readably", () => {
  assert.equal(
    nimiqErrorMessage({ error: { type: "WALLET", message: "User rejected the request" } }),
    "User rejected the request",
  );
  // Long payloads are capped, never flooding the UI.
  const big = { reason: "x".repeat(1000) };
  const capped = nimiqErrorMessage(big);
  assert.ok(capped.length <= 310, `message not capped: ${capped.length}`);
  assert.ok(capped.startsWith('{"reason":'));
});

test("syncing-your-account wallet failure maps to an actionable message", () => {
  // The exact raw shape Nimiq Pay produced for the send failure. The message
  // is network-aware, so the test PINS the network for its duration — an
  // ambient NEXT_PUBLIC_NIMIQ_NETWORK from the developer's environment (or
  // the deployment's .env.local) must not flip which branch is asserted.
  const previousNetwork = process.env.NEXT_PUBLIC_NIMIQ_NETWORK;
  process.env.NEXT_PUBLIC_NIMIQ_NETWORK = "main";
  try {
    const normalized = normalizeNimiqError(new Error(
      "Failed to send payment transaction: Something went wrong syncing your account",
    ));
    assert.equal(normalized.kind, "provider");
    assert.match(normalized.message, /still syncing your account/);
    assert.match(normalized.message, /Mainnet/);
    // Same mapping through the payment prefix used by the entry UI.
    assert.equal(
      nimiqPaymentFailureMessage(
        new Error(
          "Failed to send payment transaction: Something went wrong syncing your account",
        ),
      ),
      `Nimiq payment failed: ${normalized.message}`,
    );
  } finally {
    if (previousNetwork === undefined) delete process.env.NEXT_PUBLIC_NIMIQ_NETWORK;
    else process.env.NEXT_PUBLIC_NIMIQ_NETWORK = previousNetwork;
  }
  // "Transaction invalidated during transaction" (the Android WebView
  // failure the host produced for proof-carrying sends) is framed honestly:
  // a request the wallet never created, not a payment that failed.
  const invalidated = normalizeNimiqError(new Error(
    "Failed to send payment transaction: Transaction invalidated during transaction",
  ));
  assert.equal(invalidated.kind, "provider");
  assert.match(invalidated.message, /nothing was sent/);
  // Ordinary errors are untouched by the pattern mapping.
  assert.equal(
    normalizeNimiqError(new Error("insufficient funds")).message,
    "insufficient funds",
  );
});

test("waitForNimiqConsensus is fail-open in every unsupported path", async () => {
  const { waitForNimiqConsensus } = await import("@/lib/nimiq/miniapp");
  // Provider without the method at all: proceed immediately.
  assert.equal(await waitForNimiqConsensus({} as never, 50), true);
  // Method exists but throws (e.g. "No RPC URL configured"): proceed.
  assert.equal(
    await waitForNimiqConsensus({
      isConsensusEstablished: async () => {
        throw new Error("No RPC URL configured");
      },
    } as never, 50),
    true,
  );
  // Non-boolean response: treated as established, proceed.
  assert.equal(
    await waitForNimiqConsensus({
      isConsensusEstablished: async () => undefined as unknown as boolean,
    } as never, 50),
    true,
  );
});

test("waitForNimiqConsensus waits while not established, then proceeds", async () => {
  const { waitForNimiqConsensus } = await import("@/lib/nimiq/miniapp");
  let calls = 0;
  const start = Date.now();
  const result = await waitForNimiqConsensus({
    isConsensusEstablished: async () => {
      calls += 1;
      return calls >= 3; // false, false, then true
    },
  } as never, 5_000);
  assert.equal(result, true);
  assert.equal(calls, 3);
  assert.ok(Date.now() - start >= 500, "should have polled with 250ms gaps");
});

test("waitForNimiqConsensus returns true after timeout without throwing", async () => {
  const { waitForNimiqConsensus } = await import("@/lib/nimiq/miniapp");
  const start = Date.now();
  const result = await waitForNimiqConsensus({
    isConsensusEstablished: async () => false,
  } as never, 60);
  assert.equal(result, true);
  assert.ok(Date.now() - start >= 50, "should have waited out the timeout");
});

test("nimiqPaymentFailureMessage wraps real messages without masking them", () => {
  assert.equal(
    nimiqPaymentFailureMessage(new Error("insufficient funds")),
    "Nimiq payment failed: insufficient funds",
  );
  // The already-mangled transport error is replaced, not echoed.
  const mangled = new Error("[object Object]");
  const out = nimiqPaymentFailureMessage(mangled);
  assert.ok(!out.includes("[object Object]"), `echoed the mangled text: ${out}`);
  assert.ok(out.startsWith("Nimiq payment failed:"));
  // Structured host payloads keep their real content under the prefix.
  assert.equal(
    nimiqPaymentFailureMessage({ error: { message: "insufficient balance" } }),
    "Nimiq payment failed: insufficient balance",
  );
  // Raw objects are serialized under the prefix.
  assert.equal(
    nimiqPaymentFailureMessage({ reason: "fee too low" }),
    'Nimiq payment failed: {"reason":"fee too low"}',
  );
  // User rejections keep their classification through the payment prefix.
  assert.equal(
    nimiqPaymentFailureMessage({ error: { type: "WALLET", message: "User rejected the request" } }),
    "Nimiq payment failed: User rejected the request",
  );
});

/* ------------------------------------------------------------------ */
/* rpc.ts — real JSON-RPC over a local HTTP server                     */
/* ------------------------------------------------------------------ */

let server: Server;
let serverUrl = "";
let lastAuthHeader: string | null = null;
let lastApiKeyHeader: string | null = null;
let lastBody: { method: string; params: unknown } | null = null;
let responseMode: "ok" | "rpc-error" | "http-500" | "slow" | "garbage" | "v2-wrapped" | "v2-not-found" = "ok";
before(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastAuthHeader = req.headers.authorization ?? null;
      lastApiKeyHeader = (req.headers["api-key"] as string | undefined) ?? null;
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
      if (responseMode === "v2-not-found")
        return respond({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32603, message: "Internal error", data: `Transaction not found: ${(parsed.params as string[])[0]}` },
        });
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
      if (responseMode === "v2-wrapped") {
        // Real Nimiq v2 nodes wrap every success as { data, metadata }.
        return respond({ jsonrpc: "2.0", id: 1, result: { data: result, metadata: null } });
      }
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

test("getAccountByAddress sends the v2 named-struct form and maps the account", async () => {
  const account = await getAccountByAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000", {
    url: serverUrl,
    timeoutMs: 2_000,
  });
  assert.ok(account);
  assert.equal(account.balance, "1500000"); // string luna passed through for exact bigint handling
  // v2 dispatchers expect a named struct ({ address }) — verified live;
  // the positional array is only the fallback for older nodes.
  assert.deepEqual(lastBody?.params, { address: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000" });
});

test("getAccountByAddress falls back to positional when the struct form is rejected", async () => {
  // Dedicated server: rejects the named-struct form with -32602, answers the
  // positional retry with a valid account — mimicking a legacy dispatcher.
  const calls: unknown[] = [];
  const fallback = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(raw) as { method: string; params: unknown };
      calls.push(parsed.params);
      const positional = Array.isArray(parsed.params);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!positional) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }));
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { data: { address: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000", balance: "1500000" }, metadata: null },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => fallback.listen(0, "127.0.0.1", resolve));
  const addr = fallback.address();
  assert.ok(addr && typeof addr === "object");
  const url = `http://127.0.0.1:${addr.port}/`;
  try {
    const account = await getAccountByAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000", {
      url,
      timeoutMs: 2_000,
    });
    assert.ok(account, "the positional fallback should still return the account");
    assert.equal(calls.length, 2, "exactly two attempts: named form, then positional");
    assert.deepEqual(calls[0], { address: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000" });
    assert.deepEqual(calls[1], ["NQ07 0000 0000 0000 0000 0000 0000 0000 0000"]);
  } finally {
    fallback.close();
  }
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

test("api-key header is attached when passed, and key isolation holds", async () => {
  const savedUrl = process.env.NIMIQ_RPC_URL;
  const savedKey = process.env.NIMIQ_RPC_API_KEY;
  try {
    // Explicit override: the header rides along.
    await getBlockNumber({ url: serverUrl, apiKey: "k-explicit", timeoutMs: 2_000 });
    assert.equal(lastApiKeyHeader, "k-explicit");

    await getBlockNumber({ url: serverUrl, apiKey: null, timeoutMs: 2_000 });
    assert.equal(lastApiKeyHeader, null, "explicit null clears the header");

    // Inheritance from config when using the configured endpoint.
    process.env.NIMIQ_RPC_URL = serverUrl;
    process.env.NIMIQ_RPC_API_KEY = "k-config";
    await getBlockNumber({ timeoutMs: 2_000 });
    assert.equal(lastApiKeyHeader, "k-config", "configured endpoint inherits its key");

    // Key isolation: overriding the URL must NOT leak the configured key —
    // even when the override points at the same server. Reachable, so the
    // request actually arrives and the header capture is observable.
    await getBlockNumber({ url: serverUrl, timeoutMs: 2_000 });
    assert.equal(lastApiKeyHeader, null, "a custom URL never inherits the configured key");
  } finally {
    if (savedUrl === undefined) delete process.env.NIMIQ_RPC_URL;
    else process.env.NIMIQ_RPC_URL = savedUrl;
    if (savedKey === undefined) delete process.env.NIMIQ_RPC_API_KEY;
    else process.env.NIMIQ_RPC_API_KEY = savedKey;
  }
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

test("Nimiq v2 {data, metadata} wrapper is unwrapped transparently", async () => {
  // Verified live against rpc.testnet.nimiqwatch.com: a current v2 node
  // answers getBlockNumber with {"result":{"data":N,"metadata":null}} and
  // never the bare value.
  responseMode = "v2-wrapped";
  try {
    const height = await getBlockNumber({ url: serverUrl, timeoutMs: 2_000 });
    assert.equal(height, 1_234_567);
    const account = await getAccountByAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000", {
      url: serverUrl,
      timeoutMs: 2_000,
    });
    assert.ok(account);
    assert.equal(account.balance, "1500000");
    const tx = await getTransactionByHash("abc123", { url: serverUrl, timeoutMs: 2_000 });
    assert.ok(tx);
    assert.equal(tx.hash, "abc123");
  } finally {
    responseMode = "ok";
  }
});

test("v2 'Transaction not found' error maps to null instead of throwing", async () => {
  // Real node behavior probed live: unknown hashes come back as a JSON-RPC
  // error {code:-32603, data:"Transaction not found: <hash>"} — NOT a null
  // result. The client translates that specific error to null so callers
  // keep their "null = pending/unknown" contract.
  responseMode = "v2-not-found";
  try {
    const tx = await getTransactionByHash("b".repeat(64), { url: serverUrl, timeoutMs: 2_000 });
    assert.equal(tx, null);
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

/* ------------------------------------------------------------------ */
/* flag.ts — wallet UI must be reachable by default                    */
/* ------------------------------------------------------------------ */

test("Nimiq feature flag defaults ON when the env var is unset", () => {
  const saved = process.env.NEXT_PUBLIC_NIMIQ_ENABLED;
  try {
    delete process.env.NEXT_PUBLIC_NIMIQ_ENABLED;
    assert.equal(
      isNimiqEnabled(),
      true,
      "an unset flag must NOT hide the Connect Nimiq Wallet UI",
    );
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_NIMIQ_ENABLED;
    else process.env.NEXT_PUBLIC_NIMIQ_ENABLED = saved;
  }
});

test("Nimiq feature flag: explicit enable, aliases, and opt-outs", () => {
  const saved = process.env.NEXT_PUBLIC_NIMIQ_ENABLED;
  try {
    for (const on of ["true", "TRUE", "1", "yes", "anything-else"]) {
      process.env.NEXT_PUBLIC_NIMIQ_ENABLED = on;
      assert.equal(isNimiqEnabled(), true, `"${on}" enables`);
    }
    for (const off of ["false", "FALSE", "0", "off", "no", " Off "]) {
      process.env.NEXT_PUBLIC_NIMIQ_ENABLED = off;
      assert.equal(isNimiqEnabled(), false, `"${off}" disables`);
    }
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_NIMIQ_ENABLED;
    else process.env.NEXT_PUBLIC_NIMIQ_ENABLED = saved;
  }
});

/* ------------------------------------------------------------------ */
/* use-nimiq.ts — provider detection decision core                     */
/* ------------------------------------------------------------------ */

test("classifyProviderState: init success is available regardless of host", () => {
  assert.deepEqual(classifyProviderState(true, true, null), {
    state: "available",
    error: null,
  });
  // Inside a plain browser tab init() cannot succeed without a host, but the
  // invariant still holds: a working provider means available.
  assert.deepEqual(classifyProviderState(true, false, null), {
    state: "available",
    error: null,
  });
});

test("classifyProviderState: failure inside a Nimiq host is retryable error, never web-unavailable", () => {
  const err = { kind: "timeout" as const, message: "detection timed out" };
  const settled = classifyProviderState(false, true, err);
  assert.equal(settled.state, "error");
  if (settled.state === "error") assert.equal(settled.error, err);

  // No init error text: still an error, with a synthesized message.
  const bare = classifyProviderState(false, true, null);
  assert.equal(bare.state, "error");
  if (bare.state === "error") assert.ok(bare.error.message.length > 0);
});

test("classifyProviderState: failure with no host is the plain-web case", () => {
  const err = { kind: "timeout" as const, message: "detection timed out" };
  const settled = classifyProviderState(false, false, err);
  assert.equal(settled.state, "web-unavailable");
  if (settled.state === "web-unavailable") assert.equal(settled.error, null);
});

test("hasNimiqHost sees neither injection outside a browser", () => {
  // Node test process: no window at all.
  assert.equal(hasNimiqHost(), false);
});

/* ------------------------------------------------------------------ */
/* miniapp.ts — pickWalletAccount (connect action end to end)          */
/* ------------------------------------------------------------------ */

test("pickWalletAccount returns the provider and first account", async () => {
  const provider = fakeProvider({
    listAccounts: async () => ["NQ07 AAAA", "NQ08 BBBB"],
  });
  // Injected init() seam (ESM namespaces are frozen, so no monkey-patching):
  // the wrapper must hand back exactly what init resolved plus the first
  // listed account.
  const picked = await pickWalletAccount(1_000, {
    init: (async () => provider) as typeof sdkInit,
  });
  assert.ok(picked.ok);
  if (picked.ok) {
    assert.equal(picked.value.account, "NQ07 AAAA");
    assert.equal(picked.value.nimiq, provider);
  }
});

test("pickWalletAccount reports a typed empty-account state", async () => {
  const picked = await pickWalletAccount(1_000, {
    init: (async () =>
      fakeProvider({ listAccounts: async () => [] })) as typeof sdkInit,
  });
  assert.equal(picked.ok, false);
  if (!picked.ok) {
    assert.equal(picked.error.kind, "no-accounts");
    assert.match(picked.error.message, /create one in nimiq pay/i);
  }
});

test("pickWalletAccount propagates init and listAccounts failures", async () => {
  const failed = await pickWalletAccount(1_000, {
    init: (async () => {
      throw new Error("Nimiq provider was not injected. Are you running inside a Nimiq app?");
    }) as typeof sdkInit,
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.kind, "provider");

  const rejected = await pickWalletAccount(1_000, {
    init: (async () =>
      fakeProvider({
        listAccounts: async () => ({
          error: { type: "USER_REJECTION", message: "User denied" },
        }),
      })) as typeof sdkInit,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.kind, "user-rejected");
});
