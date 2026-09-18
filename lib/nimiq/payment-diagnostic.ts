/**
 * TEMPORARY — payment capability diagnostic (pure logic).
 *
 * Classifies the outcome of a test 0.1 NIM send through the Nimiq Pay
 * provider and the on-chain lookup of the returned hash. Deliberately pure
 * and dependency-free so the decision matrix is unit-testable without a
 * DOM, a provider, or a node (tests/node/nimiq-payment-diagnostic.test.ts).
 *
 * This is a DIAGNOSTIC, not a payment path: nothing here consumes a
 * transaction, writes a store, or feeds tournament economics. Remove the
 * UI entry (NimiqPaymentDiagnostic) and the /api/nimiq/diagnose-tx route
 * when the capability question is answered.
 */

/** The test payment: exactly 0.1 NIM, as exact luna (1 NIM = 100,000 luna). */
export const TEST_PAYMENT_NIM = "0.1";
export const TEST_PAYMENT_LUNA = 10_000n;

/** What happened when the test send was attempted. */
export type SendOutcomeKind =
  | "no-provider" // init() never produced a provider
  | "method-missing" // provider exists but sendBasicTransaction is absent
  | "user-rejected" // the user declined in Nimiq Pay's native sheet
  | "insufficient-funds" // provider refused: the wallet cannot cover it
  | "send-failed" // any other provider-side refusal
  | "submitted"; // a transaction hash came back

export interface SendOutcome {
  kind: SendOutcomeKind;
  /** Exact provider error text when the send failed (never synthesized). */
  providerError: string | null;
  /** Returned transaction hash when submitted. */
  txHash: string | null;
}

/** Minimal shape this module needs from the wallet wrapper's error. */
interface DiagnosticErrorShape {
  kind: "timeout" | "user-rejected" | "provider" | "no-accounts" | "unknown";
  message: string;
}

/** Wallet error texts that mean "the send was refused for lack of funds". */
const INSUFFICIENT_FUNDS = /insufficient|balance|not enough|too low|unfunded|fund/i;

/**
 * Classify one test-send attempt.
 *
 * `methodExists` is the runtime capability check
 * (`typeof nimiq.sendBasicTransaction === "function"`) — it outranks
 * everything: without the method there was nothing to call. A returned
 * hash always wins over an error (the provider resolved successfully).
 * An unfunded wallet is reported distinctly because it is still a
 * SUCCESSFUL capability test: the provider accepted the request and
 * Nimiq Pay's own machinery refused it for money reasons.
 */
export function classifySendOutcome(input: {
  providerAvailable: boolean;
  methodExists: boolean;
  sendError?: DiagnosticErrorShape | null;
  txHash?: string | null;
}): SendOutcome {
  if (input.txHash) {
    return { kind: "submitted", providerError: null, txHash: input.txHash };
  }
  if (!input.providerAvailable) {
    return {
      kind: "no-provider",
      providerError: input.sendError?.message ?? null,
      txHash: null,
    };
  }
  if (!input.methodExists) {
    return {
      kind: "method-missing",
      providerError: null,
      txHash: null,
    };
  }
  const message = input.sendError?.message ?? "";
  if (input.sendError?.kind === "user-rejected") {
    return { kind: "user-rejected", providerError: message, txHash: null };
  }
  if (INSUFFICIENT_FUNDS.test(message)) {
    return { kind: "insufficient-funds", providerError: message, txHash: null };
  }
  return { kind: "send-failed", providerError: message, txHash: null };
}

/** The fixed report line for the two headline verdicts. */
export function sendOutcomeHeadline(kind: SendOutcomeKind): string {
  switch (kind) {
    case "submitted":
      return "Transaction submitted — Nimiq Pay accepted the send.";
    case "insufficient-funds":
      return "Provider supports sending. Transaction could not complete because the wallet is insufficiently funded.";
    case "method-missing":
      return "Nimiq Pay provider does not expose sendBasicTransaction().";
    case "user-rejected":
      return "Send request was declined in Nimiq Pay before any transaction existed.";
    case "no-provider":
      return "No Nimiq provider is available in this environment.";
    case "send-failed":
      return "The provider refused the send request.";
  }
}

/* ------------------------------------------------------------------ */
/* On-chain lookup classification                                       */
/* ------------------------------------------------------------------ */

/** Receiving a hash proves nothing — this is where the hash actually stands. */
export type TxLookupStatus =
  | "not-yet-found" // the node has never seen the hash
  | "mempool" // seen, not yet in a block
  | "included" // in a block, not enough confirmations yet
  | "confirmed" // included with the configured confirmation count
  | "failed" // included but execution failed on-chain
  | "invalid"; // malformed response — cannot be classified

/** Minimal shape of the RPC transaction object this module classifies. */
export interface DiagnosticRpcTx {
  hash: string;
  from: string;
  to: string;
  value: number | string;
  blockNumber?: number;
  confirmations?: number;
  /** Present on current Albatross nodes; absent on some older responses. */
  executionResult?: boolean;
}

/**
 * Classify a getTransactionByHash result against the required confirmations.
 * Receiving a hash means "submitted" — nothing more. Confirmation is only
 * ever claimed from real chain data.
 */
export function classifyTxLookup(
  tx: DiagnosticRpcTx | null,
  confirmationsRequired: number,
): { status: TxLookupStatus; confirmations: number } {
  if (tx === null) return { status: "not-yet-found", confirmations: 0 };
  if (typeof tx.hash !== "string" || tx.hash.length === 0) {
    return { status: "invalid", confirmations: 0 };
  }
  const confirmations =
    typeof tx.confirmations === "number" && Number.isFinite(tx.confirmations)
      ? tx.confirmations
      : 0;
  // No block height = the node knows the transaction but it is not mined.
  if (typeof tx.blockNumber !== "number" || !Number.isFinite(tx.blockNumber)) {
    return { status: "mempool", confirmations };
  }
  if (tx.executionResult === false) {
    return { status: "failed", confirmations };
  }
  if (confirmations >= Math.max(1, confirmationsRequired)) {
    return { status: "confirmed", confirmations };
  }
  return { status: "included", confirmations };
}

/** Human line for a lookup status, for the UI and the final report. */
export function txLookupLabel(status: TxLookupStatus): string {
  switch (status) {
    case "not-yet-found":
      return "Not yet found on chain (the node has not seen the hash)";
    case "mempool":
      return "Seen by the node, not yet included in a block";
    case "included":
      return "Included in a block, awaiting confirmations";
    case "confirmed":
      return "Included and confirmed";
    case "failed":
      return "Included but execution FAILED on chain";
    case "invalid":
      return "Node returned a malformed transaction record";
  }
}
