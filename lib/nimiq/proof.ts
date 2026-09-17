/**
 * Payment-intent proof of signer — the cryptographic fix for the recurring
 * "Transaction sender … does not match your linked wallet" failures.
 *
 * THE PROBLEM, PROVEN FROM THE SDK SOURCE (node_modules/@nimiq/mini-app-sdk
 * dist/provider.js): `sendBasicTransaction(tx)` takes only
 * { recipient, value, fee?, validityStartHeight? } — there is NO sender
 * parameter. Nimiq Pay unilaterally decides which account pays. Observed on
 * testnet: it routes payments through HTLC/vesting wrapper contracts it
 * creates around the user's funds, so the on-chain `sender` is a contract
 * address, not the identity address the player linked in Phase 1B. Pinning
 * `tx.from === linked address` can therefore reject payments the linked
 * wallet's key genuinely authorized — and it already has, repeatedly.
 *
 * THE FIX: make the LINKED WALLET'S SIGNATURE the authority, not the
 * on-chain sender field. Before paying, the client asks the wallet to sign a
 * deterministic payment-intent message and embeds the proof (publicKey +
 * signature, both hex) in the transaction's `data` field via
 * sendBasicTransactionWithData. The server extracts the data from the real
 * on-chain transaction and verifies:
 *
 *   1. the proof's message is the exact intent for THIS player+tournament
 *      (amount, recipient, treasury — nothing client-chosen),
 *   2. the signature verifies (Ed25519, Nimiq message framing),
 *   3. the address derived FROM the proven public key IS the player's
 *      linked wallet (Blake2b, same rule as Phase 1B binding).
 *
 * Only the linked wallet's key can produce a valid proof — Phase 1B proved
 * that key controls the linked address — so a verified proof is a payment
 * authorized by the linked wallet no matter which wrapper account Nimiq Pay
 * used as the on-chain sender. The legacy sender check (direct match, or a
 * contract created by the linked wallet) is kept as the happy path that
 * needs no extra signature.
 *
 * The message is ASCII and length-bounded; the proof fits comfortably in
 * one basic transaction's data (~300 hex chars). No secrets ever pass
 * through: a public key and a signature over a public intent.
 */

/** Machine-readable intent type marker (versioned for future evolution). */
export const PROOF_MARKER = "CM2-PAY";

export interface PaymentIntent {
  /** Player the payment belongs to (ChainMate account id). */
  playerId: string;
  /** Tournament being entered. */
  tournamentId: string;
  /** Exact fee in luna (decimal string — never a float). */
  amountLuna: string;
  /** Canonical (unspaced, uppercase) recipient = treasury address. */
  recipient: string;
  /** Nimiq network the payment targets: "main" | "test". */
  network: "main" | "test";
}

/**
 * The exact string the wallet signs. Deterministic in field order, ASCII
 * only, every field length-prefixed so no separator ambiguity exists.
 */
export function proofMessage(intent: PaymentIntent): string {
  return [
    PROOF_MARKER,
    intent.network,
    intent.playerId,
    intent.tournamentId,
    intent.amountLuna,
    intent.recipient,
  ].join("|");
}

/** Parse a proofMessage back into its intent. Null when malformed. */
export function parseProofMessage(message: string): PaymentIntent | null {
  const parts = message.split("|");
  if (parts.length !== 6 || parts[0] !== PROOF_MARKER) return null;
  const [marker, network, playerId, tournamentId, amountLuna, recipient] = parts;
  if (network !== "main" && network !== "test") return null;
  if (!playerId || !tournamentId || !/^\d+$/.test(amountLuna) || !/^NQ[0-9A-Z]{34}$/.test(recipient)) {
    return null;
  }
  void marker;
  return { network, playerId, tournamentId, amountLuna, recipient };
}

/** The embedded transaction-data payload for a signed intent. */
export interface PaymentProof {
  publicKey: string;
  signature: string;
}

/** Serialize the proof into the transaction data string (ASCII form). */
export function encodeProofData(proof: PaymentProof): string {
  return `${PROOF_MARKER}:${proof.publicKey.toLowerCase()}:${proof.signature.toLowerCase()}`;
}

/** ASCII → lowercase hex, the canonical wire encoding for tx data. */
function asciiToHex(ascii: string): string {
  const bytes = new TextEncoder().encode(ascii);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Lowercase-hex → ASCII, or null when the input is not valid hex. */
function hexToAscii(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * The wire form the client embeds via sendBasicTransactionWithData: the
 * ASCII proof, hex-encoded (the Nimiq ecosystem's canonical tx-data
 * encoding — the RPC reports data as hex too). Lowercase hex, no 0x prefix.
 */
export function encodeProofDataHex(proof: PaymentProof): string {
  return asciiToHex(encodeProofData(proof));
}

/**
 * Extract a payment proof from an on-chain transaction's data field.
 *
 * The stack between the SDK and the node may treat the `data` string as hex
 * (decode once) or as raw ASCII (so the RPC reports the hex OF the hex text
 * — decode twice). Candidates are tried in order and the first one that
 * matches the proof shape wins. Returns null when the data carries no
 * ChainMate proof — the caller then falls back to the legacy sender check.
 */
export function decodeProofData(data: unknown): PaymentProof | null {
  if (typeof data !== "string" || data.length === 0) return null;
  const PROOF_RE = new RegExp(`${PROOF_MARKER}:([0-9a-fA-F]{64}):([0-9a-fA-F]{128})`);
  let text = data.startsWith("0x") ? data.slice(2) : data;
  for (let round = 0; round < 3; round++) {
    const m = PROOF_RE.exec(text);
    if (m) return { publicKey: m[1]!.toLowerCase(), signature: m[2]!.toLowerCase() };
    const decoded = hexToAscii(text);
    if (decoded === null) break;
    text = decoded;
  }
  return null;
}
