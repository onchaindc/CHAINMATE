/**
 * TEMPORARY payment-diagnostic tests — the classification logic for the
 * "Test 0.1 NIM Payment" capability check.
 *
 * Covers the decision matrix without a provider, a DOM, or a node:
 *  - classifySendOutcome: hash wins, provider/method precedence,
 *    user-rejection, INSUFFICIENT FUNDS as a successful capability test,
 *    and unknown provider errors surfaced verbatim.
 *  - classifyTxLookup: null → not-yet-found, mempool, included,
 *    confirmed, failed-execution, malformed.
 *
 * Nothing here claims a real transaction works — these are pure-function
 * tests of what the diagnostic is allowed to report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TEST_PAYMENT_LUNA,
  TEST_PAYMENT_NIM,
  classifySendOutcome,
  sendOutcomeHeadline,
  classifyTxLookup,
  txLookupLabel,
} from "@/lib/nimiq/payment-diagnostic";

test("test payment constants are exactly 0.1 NIM", () => {
  assert.equal(TEST_PAYMENT_NIM, "0.1");
  assert.equal(TEST_PAYMENT_LUNA, 10_000n);
});

test("classifySendOutcome: a returned hash is 'submitted' and outranks any error", () => {
  const outcome = classifySendOutcome({
    providerAvailable: true,
    methodExists: true,
    sendError: { kind: "provider", message: "ignored" },
    txHash: "abc123",
  });
  assert.equal(outcome.kind, "submitted");
  assert.equal(outcome.txHash, "abc123");
  assert.equal(outcome.providerError, null);
});

test("classifySendOutcome: missing provider beats everything except a hash", () => {
  const outcome = classifySendOutcome({
    providerAvailable: false,
    methodExists: false,
    sendError: { kind: "provider", message: "not injected" },
    txHash: null,
  });
  assert.equal(outcome.kind, "no-provider");
  assert.equal(outcome.providerError, "not injected");
});

test("classifySendOutcome: method-missing is reported distinctly", () => {
  const outcome = classifySendOutcome({
    providerAvailable: true,
    methodExists: false,
    txHash: null,
  });
  assert.equal(outcome.kind, "method-missing");
  assert.equal(sendOutcomeHeadline("method-missing"), "Nimiq Pay provider does not expose sendBasicTransaction().");
});

test("classifySendOutcome: user rejection is its own verdict", () => {
  const outcome = classifySendOutcome({
    providerAvailable: true,
    methodExists: true,
    sendError: { kind: "user-rejected", message: "User declined the request" },
    txHash: null,
  });
  assert.equal(outcome.kind, "user-rejected");
  assert.equal(outcome.providerError, "User declined the request");
});

test("classifySendOutcome: insufficient funds is a successful capability test", () => {
  const outcome = classifySendOutcome({
    providerAvailable: true,
    methodExists: true,
    sendError: {
      kind: "provider",
      message: "Failed to send payment transaction: insufficient funds",
    },
    txHash: null,
  });
  assert.equal(outcome.kind, "insufficient-funds");
  assert.equal(
    sendOutcomeHeadline("insufficient-funds"),
    "Provider supports sending. Transaction could not complete because the wallet is insufficiently funded.",
  );
  // The exact provider error survives for the report.
  assert.match(outcome.providerError!, /insufficient funds/);
});

test("classifySendOutcome: balance-worded refusals also classify as unfunded", () => {
  const outcome = classifySendOutcome({
    providerAvailable: true,
    methodExists: true,
    sendError: { kind: "provider", message: "sender balance too low" },
    txHash: null,
  });
  assert.equal(outcome.kind, "insufficient-funds");
});

test("classifySendOutcome: other provider errors pass through verbatim", () => {
  const outcome = classifySendOutcome({
    providerAvailable: true,
    methodExists: true,
    sendError: { kind: "provider", message: "Something went wrong syncing your account" },
    txHash: null,
  });
  assert.equal(outcome.kind, "send-failed");
  assert.equal(outcome.providerError, "Something went wrong syncing your account");
});

test("classifyTxLookup: null means the node has not seen the hash", () => {
  const r = classifyTxLookup(null, 10);
  assert.equal(r.status, "not-yet-found");
  assert.equal(txLookupLabel(r.status), "Not yet found on chain (the node has not seen the hash)");
});

test("classifyTxLookup: a transaction without a block height is mempool", () => {
  const r = classifyTxLookup(
    { hash: "h", from: "a", to: "b", value: "10000" },
    10,
  );
  assert.equal(r.status, "mempool");
});

test("classifyTxLookup: included below the required confirmations", () => {
  const r = classifyTxLookup(
    { hash: "h", from: "a", to: "b", value: "10000", blockNumber: 500, confirmations: 3 },
    10,
  );
  assert.equal(r.status, "included");
  assert.equal(txLookupLabel(r.status), "Included in a block, awaiting confirmations");
});

test("classifyTxLookup: confirmed at the required confirmations (inclusive)", () => {
  const r = classifyTxLookup(
    { hash: "h", from: "a", to: "b", value: "10000", blockNumber: 500, confirmations: 10 },
    10,
  );
  assert.equal(r.status, "confirmed");
  assert.equal(r.confirmations, 10);
});

test("classifyTxLookup: included but failed execution is 'failed'", () => {
  const r = classifyTxLookup(
    {
      hash: "h",
      from: "a",
      to: "b",
      value: "10000",
      blockNumber: 500,
      confirmations: 12,
      executionResult: false,
    },
    10,
  );
  assert.equal(r.status, "failed");
  assert.equal(txLookupLabel(r.status), "Included but execution FAILED on chain");
});

test("classifyTxLookup: a record with no hash is invalid", () => {
  const r = classifyTxLookup({ hash: "", from: "a", to: "b", value: "0" }, 10);
  assert.equal(r.status, "invalid");
});
