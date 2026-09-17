/**
 * Nimiq address encoding/derivation — pure, client-safe crypto.
 *
 * Shared by the server verifier (Phase 1B/1C) and the client entry flow
 * (Phase 2B pre-send account check). Everything here is derived from
 * authoritative sources, not guesswork:
 *
 *  - Address format: nimiq/core-rs-albatross keys/src/address.rs — a Nimiq
 *    address is the FIRST 20 BYTES of Blake2b-256(public key), custom base32
 *    encoded ("0123456789ABCDEFGHJKLMNPQRSTUVXY"), prefixed "NQ" plus an
 *    IBAN-style mod-97 checksum (2 digits), displayed in 4-char groups.
 *
 * No secrets, no network, no Node APIs — safe in the browser bundle.
 */

import { blake2b } from "@noble/hashes/blake2b";

/** The Nimiq base32 alphabet (no I, O, Z — deliberately unambiguous). */
export const NIMIQ_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVXY";
export const ADDRESS_LEN = 20;

export class NimiqAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimiqAddressError";
  }
}

export function base32Encode(bytes: Uint8Array): string {
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

export function base32Decode(str: string): Uint8Array {
  const clean = str.replace(/[\s-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = NIMIQ_ALPHABET.indexOf(c);
    if (idx === -1) throw new NimiqAddressError(`Invalid base32 character: ${c}`);
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
export function ibanChecksumMod97(iban: string): number {
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
      throw new NimiqAddressError(`Invalid character in address: ${c}`);
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
    throw new NimiqAddressError(`Address bytes must be ${ADDRESS_LEN}, got ${bytes.length}`);
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
  if (canonical.length !== 36) throw new NimiqAddressError("Nimiq address must be 36 characters");
  if (!canonical.startsWith("NQ")) throw new NimiqAddressError("Nimiq address must start with NQ");
  const body = canonical.slice(4);
  // Recompute the checksum from the body and compare with the embedded one.
  const rebuilt = `NQ00${body}`;
  const expected = (98 - ibanChecksumMod97(rebuilt)).toString().padStart(2, "0");
  if (canonical.slice(2, 4) !== expected) {
    throw new NimiqAddressError("Invalid Nimiq address checksum");
  }
  const bytes = base32Decode(body);
  if (bytes.length !== ADDRESS_LEN) {
    throw new NimiqAddressError("Nimiq address body must decode to 20 bytes");
  }
  return canonical;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Validate a hex-encoded ed25519 public key (32 bytes). */
export function validatePublicKeyBytes(publicKey: string): Uint8Array {
  if (!HEX64.test(publicKey)) {
    throw new NimiqAddressError("Public key must be 64 hex characters (32 bytes)");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(publicKey.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derive the user-friendly Nimiq address of an ed25519 public key:
 * Blake2b-256(pubkey) → first 20 bytes → NQ + checksum + grouping.
 * Throws on malformed input.
 */
export function addressFromPublicKey(publicKeyHex: string): string {
  const pub = validatePublicKeyBytes(publicKeyHex);
  const hash = blake2b(pub, { dkLen: 32 });
  return addressFromBytes(hash.slice(0, ADDRESS_LEN));
}

/**
 * Group a canonical 36-char address into the friendly spaced form users see
 * in Nimiq Pay and block explorers ("NQ64 66X5 …"). Non-standard inputs pass
 * through compact so display text never fabricates an address.
 */
export function friendlyAddress(address: string): string {
  const compact = canonicalAddress(address);
  if (compact.length !== 36) return compact || "(unknown)";
  return `${compact.slice(0, 4)} ${(compact.slice(4).match(/.{1,4}/g) ?? []).join(" ")}`;
}
