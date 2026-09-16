/**
 * Regression tests for the Nimiq entry-verification retry policy.
 *
 * Pins the behavior behind the "Transaction has 2 confirmations, 10 required"
 * failure: the client must treat insufficient confirmations as TRANSIENT
 * (retry the same hash), transport failures as transient, and business
 * rejections (wrong sender, replay, etc.) as terminal.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VERIFY_MAX_ATTEMPTS,
  confirmationsPending,
  isRetryableVerificationError,
  verificationProgressMessage,
} from "@/lib/nimiq/verify-retry";
import { TournamentApiError } from "@/lib/tournament-api";

test("confirmationsPending parses the server's insufficient-confirmations message", () => {
  assert.deepEqual(
    confirmationsPending("Transaction has 2 confirmations, 10 required"),
    { have: 2, required: 10 },
  );
  assert.deepEqual(
    confirmationsPending("Transaction has 9 confirmations, 10 required"),
    { have: 9, required: 10 },
  );
  assert.deepEqual(
    confirmationsPending("Transaction has 1 confirmation, 10 required"),
    { have: 1, required: 10 },
  );
});

test("confirmationsPending returns null for other messages", () => {
  assert.equal(confirmationsPending("Transaction sender does not match your linked wallet"), null);
  assert.equal(confirmationsPending(""), null);
  assert.equal(confirmationsPending("Transaction has many confirmations, 10 required"), null);
});

test("insufficient confirmations are retryable", () => {
  const err = new TournamentApiError("Transaction has 2 confirmations, 10 required", {
    kind: "verification-failed",
    status: 502,
  });
  assert.equal(isRetryableVerificationError(err), true);
});

test("node transport failures are retryable", () => {
  const cases: Array<[string, string | null]> = [
    [
      "Nimiq payment failed: The Nimiq node could not be reached to verify this transaction (getaddrinfo ENOTFOUND)",
      "verification-failed",
    ],
    ["Could not read the current chain height (HTTP 503)", "verification-failed"],
    ["Transaction exists but is not yet included in a block", "verification-failed"],
  ];
  for (const [message, kind] of cases) {
    assert.equal(
      isRetryableVerificationError(new TournamentApiError(message, { kind, status: 502 })),
      true,
      `expected retryable: ${message}`,
    );
  }
});

test("terminal verification failures are never retried", () => {
  const cases: Array<[string, string | null]> = [
    ["Nimiq payment failed: Transaction sender does not match your linked wallet", "verification-failed"],
    ["Transaction recipient is not the expected address", "verification-failed"],
    ["Transaction amount does not match the expected amount", "verification-failed"],
    ["Transaction execution failed on-chain", "verification-failed"],
    ["This transaction was already consumed", "already-paid"],
    ["This transaction was already consumed", "verification-failed"],
    ["The tournament is full", "tournament-full"],
    ["You have already paid to join this tournament", "already-paid"],
  ];
  for (const [message, kind] of cases) {
    assert.equal(
      isRetryableVerificationError(new TournamentApiError(message, { kind, status: 400 })),
      false,
      `expected terminal: ${message}`,
    );
  }
});

test("TournamentApiError carries the server's typed kind for classification", () => {
  const err = new TournamentApiError("Transaction has 2 confirmations, 10 required", {
    kind: "verification-failed",
    status: 502,
  });
  assert.equal(err.kind, "verification-failed");
  assert.equal(err.status, 502);
  assert.ok(err instanceof Error);
});

test("progress copy reflects the confirmation gap", () => {
  const far = verificationProgressMessage({ have: 2, required: 10 });
  assert.match(far, /2\/10/);
  assert.match(far, /leave this page/);
  const close = verificationProgressMessage({ have: 9, required: 10 });
  assert.match(close, /9\/10/);
  assert.match(close, /Almost there/);
});

test("retry window is sane", () => {
  assert.ok(VERIFY_MAX_ATTEMPTS >= 2, "at least one retry");
  assert.ok(VERIFY_MAX_ATTEMPTS <= 60, "bounded polling, not infinite");
});
