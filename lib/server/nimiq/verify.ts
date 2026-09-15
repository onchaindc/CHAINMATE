// Server-only module — never import from client components.

/**
 * Nimiq signature + address verification — Phase 1B.
 *
 * Everything here is derived from authoritative sources, not guesswork:
 *
 *  - Address format: nimiq/core-rs-albatross keys/src/address.rs — a Nimiq
 *    address is the FIRST 20 BYTES of Blake2b-256(public key), custom base32
 *    encoded ("0123456789ABCDEFGHJKLMNPQRSTUVXY"), prefixed "NQ" plus an
 *    IBAN-style mod-97 checksum (2 digits), displayed in 4-char groups.
 *  - Signatures: Ed25519 (RFC 8032) via @noble/ed25519, over SHA-256 of the
 *    Nimiq-framed challenge message — NOT over the raw message bytes.
 *    @noble/ed25519 v2 requires sha512 to be provided by the application
 *    (documented design), which we supply from @noble/hashes.
 *
 * The challenge message format is deterministic (see challengeMessage()):
 *
 *   chainmate-link:{network}:{playerId}:{nonce}:{issuedAt}
 *
 * Byte-exactness note: the framing operates on UTF-8 bytes of the message
 * string. The message contains only ASCII, so every client and the server
 * encode it identically.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { sha256, sha512 } from "@noble/hashes/sha2";
import * as ed from "@noble/ed25519";

// @noble/ed25519 v2 application-supplied hashing (documented design): both
// the async and sync forms are provided so every call path works.
if (!ed.etc.sha512Async) ed.etc.sha512Async = async (m: Uint8Array) => sha512(m);
if (!ed.etc.sha512Sync) ed.etc.sha512Sync = (m: Uint8Array) => sha512(m);

/** The Nimiq base32 alphabet (no I, O, Z — deliberately unambiguous). */
const NIMIQ_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVXY";
const ADDRESS_LEN = 20;

export class NimiqVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimiqVerifyError";
  }
}

/* ------------------------------------------------------------------ */
/* Challenge messages and nonces                                       */
/* ------------------------------------------------------------------ */

/** Exact deterministic link message for a challenge. */
export function challengeMessage(params: {
  network: string;
  playerId: string;
  nonce: string;
  issuedAt: number;
}): string {
  return `chainmate-link:${params.network}:${params.playerId}:${params.nonce}:${params.issuedAt}`;
}

/**
 * 32 cryptographically random bytes, hex-encoded (64 chars). Uses the
 * platform CSPRNG (Web Crypto global, backed by node:crypto in the Node
 * runtime) — never Math.random.
 */
export function generateChallengeNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Address encoding / validation                                       */
/* ------------------------------------------------------------------ */

function base32Encode(bytes: Uint8Array): string {
  // data_encoding default (RFC4648 padding-free) semantics over the Nimiq
  // alphabet: 5-bit groups, MSB first.
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += NIMIQ_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += NIMIQ_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Uint8Array {
  const clean = str.replace(/[\s-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = NIMIQ_ALPHABET.indexOf(c);
    if (idx === -1) throw new NimiqVerifyError(`Invalid base32 character: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** IBAN-style mod-97 over the "NQ" + 2 digits + base32 body. */
function ibanChecksumMod97(iban: string): number {
  // Move the first 4 chars to the end, then map letters to base-36 numbers.
  const reordered = iban.slice(4) + iban.slice(0, 4);
  let checksum = 0;
  for (const c of reordered) {
    if (c >= "0" && c <= "9") {
      checksum = (checksum * 10 + (c.charCodeAt(0) - 48)) % 97;
    } else if (c >= "A" && c <= "Z") {
      const n = c.charCodeAt(0) - 65 + 10;
      // Two-digit values must be applied mod-97-safe: 10..35 span two digits.
      checksum = (checksum * 100 + n) % 97;
    } else {
      throw new NimiqVerifyError(`Invalid character in address: ${c}`);
    }
  }
  return checksum;
}

/** Uppercase, space-stripped canonical address form (36 chars). */
export function canonicalAddress(address: string): string {
  return address.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Encode 20 raw address bytes into the user-friendly NQ form with checksum.
 */
export function addressFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== ADDRESS_LEN) {
    throw new NimiqVerifyError(`Address bytes must be ${ADDRESS_LEN}, got ${bytes.length}`);
  }
  const base32 = base32Encode(bytes);
  const payload = `NQ00${base32}`;
  const check = 98 - ibanChecksumMod97(payload);
  const friendly = `NQ${check.toString().padStart(2, "0")}${base32}`;
  // Group into 4s: NQ07 0000 0000 … (36 chars, 9 groups incl. NQ07).
  return (friendly.match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * Validate a user-friendly Nimiq address: shape, alphabet, and IBAN checksum.
 * Returns the canonical (uppercase, unspaced) form. Accepts grouped or
 * ungrouped input.
 */
export function validateNimiqAddress(address: string): string {
  const canonical = canonicalAddress(address);
  if (canonical.length !== 36) throw new NimiqVerifyError("Nimiq address must be 36 characters");
  if (!canonical.startsWith("NQ")) throw new NimiqVerifyError("Nimiq address must start with NQ");
  const body = canonical.slice(4);
  // Recompute the checksum from the body and compare with the embedded one.
  const rebuilt = `NQ00${body}`;
  const expected = (98 - ibanChecksumMod97(rebuilt)).toString().padStart(2, "0");
  if (canonical.slice(2, 4) !== expected) {
    throw new NimiqVerifyError("Invalid Nimiq address checksum");
  }
  const bytes = base32Decode(body);
  if (bytes.length !== ADDRESS_LEN) {
    throw new NimiqVerifyError("Nimiq address body must decode to 20 bytes");
  }
  return canonical;
}

/* ------------------------------------------------------------------ */
/* Keys, signatures, derivation                                        */
/* ------------------------------------------------------------------ */

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Validate a hex-encoded ed25519 public key (32 bytes). */
export function validatePublicKey(publicKey: string): Uint8Array {
  if (!HEX64.test(publicKey)) {
    throw new NimiqVerifyError("Public key must be 64 hex characters (32 bytes)");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(publicKey.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Validate a hex-encoded ed25519 signature (64 bytes). */
export function validateSignatureHex(signature: string): Uint8Array {
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) {
    throw new NimiqVerifyError("Signature must be 128 hex characters (64 bytes)");
  }
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bytes[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derive the user-friendly Nimiq address of an ed25519 public key:
 * Blake2b-256(pubkey) → first 20 bytes → NQ + checksum + grouping.
 */
export function addressFromPublicKey(publicKeyHex: string): string {
  const pub = validatePublicKey(publicKeyHex);
  const hash = blake2b(pub, { dkLen: 32 });
  return addressFromBytes(hash.slice(0, ADDRESS_LEN));
}

/**
 * Nimiq's canonical message-signing convention — the EXACT algorithm Nimiq
 * Pay applies to every sign() request. Mirrored from
 * nimiq/core-rs-albatross wallet/src/wallet_account.rs
 * (WalletAccount::prepare_message_for_signature; same convention as the
 * legacy Keyguard `Key.signMessage`):
 *
 *   prefix  = "\x16Nimiq Signed Message:\n"   (0x16 = 22 = prefix byte length,
 *                                               the Bitcoin-style length tag)
 *   buffer  = prefix || ascii(utf8ByteLength(message)) || utf8(message)
 *   signed  = SHA-256(buffer)                 (32 bytes — what Ed25519 signs)
 *
 * A wallet therefore NEVER signs the raw message bytes. Verifying against
 * raw UTF-8 fails for every real Nimiq Pay signature — the exact bug this
 * module's previous version had (tests passed only because the test helper
 * made the same raw-bytes assumption). The framing also binds the signature
 * to "Nimiq signed message" semantics so it can never be replayed as a
 * transaction signature.
 */
export const NIMIQ_SIGN_MESSAGE_PREFIX = "\x16Nimiq Signed Message:\n";

/** The exact 32 bytes Nimiq wallets sign for a given message string. */
export function nimiqMessageSigningHash(message: string): Uint8Array {
  const messageBytes = new TextEncoder().encode(message);
  const lengthAscii = new TextEncoder().encode(String(messageBytes.byteLength));
  const prefixBytes = new TextEncoder().encode(NIMIQ_SIGN_MESSAGE_PREFIX);
  const buffer = new Uint8Array(
    prefixBytes.byteLength + lengthAscii.byteLength + messageBytes.byteLength,
  );
  buffer.set(prefixBytes, 0);
  buffer.set(lengthAscii, prefixBytes.byteLength);
  buffer.set(messageBytes, prefixBytes.byteLength + lengthAscii.byteLength);
  return sha256(buffer);
}

/**
 * Verify an Ed25519 signature over the Nimiq-framed challenge message hash.
 * Throws on malformed inputs; returns false on a well-formed wrong signature.
 */
export async function verifyChallengeSignature(params: {
  message: string;
  signatureHex: string;
  publicKeyHex: string;
}): Promise<boolean> {
  const signedBytes = nimiqMessageSigningHash(params.message);
  const signature = validateSignatureHex(params.signatureHex);
  const publicKey = validatePublicKey(params.publicKeyHex);
  return ed.verifyAsync(signature, signedBytes, publicKey);
}
