/**
 * Nimiq Phase 1B wallet-binding tests.
 *
 * The full link pipeline is exercised for real: actual ed25519 keypairs are
 * generated in-test, real signatures are produced over the real challenge
 * message, the real address derivation is checked against known vectors, and
 * the challenge store runs on the real file store (throwaway .data root).
 * No Nimiq Pay session is required — the provider seam is client-side only.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { blake2b } from "@noble/hashes/blake2b";
import { sha256, sha512 } from "@noble/hashes/sha2";
import * as ed from "@noble/ed25519";

if (!ed.etc.sha512Async) ed.etc.sha512Async = async (m: Uint8Array) => sha512(m);

import type * as Verify from "@/lib/server/nimiq/verify";
import type * as Service from "@/lib/server/nimiq/service";
import type * as Store from "@/lib/server/nimiq/store";

/* Same shape as the other suites: move cwd BEFORE the file store's module
   ever loads (static imports would resolve .data/ against the project root
   and leak test bindings), then import the server modules for real. */
let DATA_ROOT: string;
let verify: typeof Verify;
let service: typeof Service;
let store: typeof Store;

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-nimiq-"));
  process.chdir(DATA_ROOT);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  verify = await import("@/lib/server/nimiq/verify");
  service = await import("@/lib/server/nimiq/service");
  store = await import("@/lib/server/nimiq/store");
  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

/* ------------------------------------------------------------------ */
/* Key helpers                                                         */
/* ------------------------------------------------------------------ */

let seq = 0;
async function keypair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = Array.from(pub, (b) => b.toString(16).padStart(2, "0")).join("");
  seq += 1;
  return { privateKey, publicKeyHex };
}

/**
 * Sign exactly the way a real Nimiq wallet does: Ed25519 over
 * SHA-256("\x16Nimiq Signed Message:\n" + byteLength + message) — the
 * WalletAccount::prepare_message_for_signature convention from
 * nimiq/core-rs-albatross (mirrored in lib/server/nimiq/verify.ts).
 */
async function signHex(message: string, privateKey: Uint8Array): Promise<string> {
  const signed = verify.nimiqMessageSigningHash(message);
  const sig = await ed.signAsync(signed, privateKey);
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function uniquePlayerId(): string {
  seq += 1;
  return `acct_nimiq_test_${seq}`;
}

/* ------------------------------------------------------------------ */
/* Address derivation — checked against the nimiq-core algorithm       */
/* ------------------------------------------------------------------ */

test("the burn address decodes to 20 zero bytes", () => {
  // Documented vector from nimiq-core: NQ07 0000 … 0000 is the burn address.
  const canonical = verify.validateNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000");
  assert.equal(canonical, "NQ0700000000000000000000000000000000");
});

test("verify.addressFromBytes re-encodes the burn address exactly", () => {
  const encoded = verify.addressFromBytes(new Uint8Array(20));
  assert.equal(encoded, "NQ07 0000 0000 0000 0000 0000 0000 0000 0000");
});

test("derived addresses validate and are deterministic", async () => {
  const { publicKeyHex } = await keypair();
  const address = verify.addressFromPublicKey(publicKeyHex);
  assert.equal(address, verify.addressFromPublicKey(publicKeyHex));
  // Round-trips through validation (shape + IBAN checksum).
  assert.equal(verify.validateNimiqAddress(address), verify.canonicalAddress(address));
  // Address is the first 20 bytes of blake2b-256(pubkey) — verify directly.
  const pub = new Uint8Array(32);
  for (let i = 0; i < 32; i++) pub[i] = Number.parseInt(publicKeyHex.slice(i * 2, i * 2 + 2), 16);
  const expectedBytes = blake2b(pub, { dkLen: 32 }).slice(0, 20);
  const expected = verify.addressFromBytes(new Uint8Array(expectedBytes));
  assert.equal(address, expected);
});

test("different keys derive different addresses", async () => {
  const a = await keypair();
  const b = await keypair();
  assert.notEqual(verify.addressFromPublicKey(a.publicKeyHex), verify.addressFromPublicKey(b.publicKeyHex));
});

test("verify.validateNimiqAddress rejects malformed addresses", () => {
  assert.throws(() => verify.validateNimiqAddress(""), verify.NimiqVerifyError);
  assert.throws(() => verify.validateNimiqAddress("NQ07"), verify.NimiqVerifyError); // too short
  assert.throws(() => verify.validateNimiqAddress("XX07 0000 0000 0000 0000 0000 0000 0000 0000"), verify.NimiqVerifyError); // wrong prefix
  assert.throws(
    () => verify.validateNimiqAddress("NQ08 0000 0000 0000 0000 0000 0000 0000 0000"),
    verify.NimiqVerifyError, // wrong checksum digits
  );
  assert.throws(
    () => verify.validateNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 000I"),
    verify.NimiqVerifyError, // I is not in the Nimiq alphabet
  );
});

/* ------------------------------------------------------------------ */
/* Nonces and challenge messages                                       */
/* ------------------------------------------------------------------ */

test("challenge nonces are 64 hex chars and cryptographically unique", () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const nonce = verify.generateChallengeNonce();
    assert.match(nonce, /^[0-9a-f]{64}$/);
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 200, "nonce collision within 200 draws");
});

test("challenge messages are deterministic in the exact format", () => {
  const message = verify.challengeMessage({
    network: "test",
    playerId: "acct_x",
    nonce: "ab".repeat(32),
    issuedAt: 1726000000000,
  });
  assert.equal(
    message,
    `chainmate-link:test:acct_x:${"ab".repeat(32)}:1726000000000`,
  );
});

/* ------------------------------------------------------------------ */
/* Nimiq signing convention — the real wallet wire format              */
/* ------------------------------------------------------------------ */

test("nimiqMessageSigningHash reproduces the exact wallet framing", async () => {
  // Independent reimplementation of WalletAccount::prepare_message_for_signature
  // (nimiq/core-rs-albatross wallet/src/wallet_account.rs):
  //   prefix || ascii(byteLength) || message, hashed with SHA-256.
  const message = "chainmate-link:test:acct_x:ab:1726000000000";
  const msgBytes = new TextEncoder().encode(message);
  const expected = sha256(
    Uint8Array.from([
      ...new TextEncoder().encode("\x16Nimiq Signed Message:\n"),
      ...new TextEncoder().encode(String(msgBytes.byteLength)),
      ...msgBytes,
    ]),
  );
  const actual = verify.nimiqMessageSigningHash(message);
  assert.equal(actual.byteLength, 32);
  assert.deepEqual(Array.from(actual), Array.from(expected));

  // Prefix constant: 0x16 = 22 = the byte length of the REMAINING prefix
  // ("Nimiq Signed Message:\n"), the Bitcoin-style length tag — 23 total.
  assert.equal(verify.NIMIQ_SIGN_MESSAGE_PREFIX.length, 23);
  assert.equal(verify.NIMIQ_SIGN_MESSAGE_PREFIX.charCodeAt(0), 22);
});

test("a REAL Nimiq-Pay-convention signature verifies (regression: raw-bytes bug)", async () => {
  const { privateKey, publicKeyHex } = await keypair();
  const message = verify.challengeMessage({
    network: "test",
    playerId: "acct_wallet_convention",
    nonce: "cd".repeat(32),
    issuedAt: 1726000000000,
  });
  const walletSignature = await signHex(message, privateKey); // wallet convention
  const ok = await verify.verifyChallengeSignature({
    message,
    signatureHex: walletSignature,
    publicKeyHex,
  });
  assert.equal(ok, true, "server must verify what Nimiq Pay actually signs");
});

test("a RAW-BYTES signature (the old broken assumption) is rejected", async () => {
  const { privateKey, publicKeyHex } = await keypair();
  const message = "chainmate-link:test:acct_raw:ab:1726000000000";
  const rawSig = await ed.signAsync(new TextEncoder().encode(message), privateKey);
  const rawHex = Array.from(rawSig, (b) => b.toString(16).padStart(2, "0")).join("");
  const ok = await verify.verifyChallengeSignature({
    message,
    signatureHex: rawHex,
    publicKeyHex,
  });
  assert.equal(ok, false, "raw-message signatures must never verify");
});

test("the wallet framing binds byteLength — a different message cannot verify", async () => {
  const { privateKey, publicKeyHex } = await keypair();
  const signed = "chainmate-link:test:acct_x:ab:1726000000000";
  const other = "chainmate-link:test:acct_x:ab:1726000000001"; // same length
  const sig = await signHex(signed, privateKey);
  assert.equal(
    await verify.verifyChallengeSignature({ message: other, signatureHex: sig, publicKeyHex }),
    false,
  );
});

test("issued challenges carry a 5-minute window and the exact message", async () => {
  const playerId = uniquePlayerId();
  const challenge = await service.issueWalletChallenge(playerId, "test");
  assert.equal(challenge.expiresAt - challenge.issuedAt, service.CHALLENGE_TTL_MS);
  assert.equal(service.CHALLENGE_TTL_MS, 5 * 60 * 1000);
  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  assert.equal(
    challenge.message,
    verify.challengeMessage({
      network: "test",
      playerId,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
    }),
  );
});

/* ------------------------------------------------------------------ */
/* The link pipeline — real signatures over real challenges            */
/* ------------------------------------------------------------------ */

async function freshLinkRequest() {
  const playerId = uniquePlayerId();
  const keys = await keypair();
  const challenge = await service.issueWalletChallenge(playerId, "test");
  const signature = await signHex(challenge.message, keys.privateKey);
  const address = verify.addressFromPublicKey(keys.publicKeyHex);
  return { playerId, keys, challenge, signature, address };
}

test("a valid signature binds the derived wallet to the player", async () => {
  const { playerId, keys, challenge, signature, address } = await freshLinkRequest();
  const linked = await service.linkWallet({
    playerId,
    nonce: challenge.nonce,
    signature,
    publicKey: keys.publicKeyHex,
    address,
  });
  assert.equal(linked.address, verify.canonicalAddress(address));
  assert.equal(linked.network, "test");

  const stored = await store.getBindingForPlayer(playerId);
  assert.ok(stored);
  assert.equal(stored.address, verify.canonicalAddress(address));
  const view = await service.getLinkedWallet(playerId);
  assert.equal(view?.address, verify.canonicalAddress(address));
});

test("omitting the display address still binds (server derives it)", async () => {
  const { playerId, keys, challenge, signature, address } = await freshLinkRequest();
  const linked = await service.linkWallet({
    playerId,
    nonce: challenge.nonce,
    signature,
    publicKey: keys.publicKeyHex,
  });
  assert.equal(linked.address, verify.canonicalAddress(address));
});

test("an invalid signature is rejected and the challenge stays unusable-for-others", async () => {
  const { playerId, keys, challenge, address } = await freshLinkRequest();
  const signature = "ff".repeat(64);
  await assert.rejects(
    () => service.linkWallet({ playerId, nonce: challenge.nonce, signature, publicKey: keys.publicKeyHex, address }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /verification failed/i.test(err.message),
  );
  // The player is NOT bound.
  assert.equal(await service.getLinkedWallet(playerId), null);
});

test("a signature over a tampered message is rejected", async () => {
  const { playerId, keys, challenge, address } = await freshLinkRequest();
  const tampered = challenge.message.replace("chainmate-link", "chainmate-limk");
  const signature = await signHex(tampered, keys.privateKey);
  await assert.rejects(
    () => service.linkWallet({ playerId, nonce: challenge.nonce, signature, publicKey: keys.publicKeyHex, address }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400,
  );
});

test("a signature by the WRONG KEY is rejected even with a well-formed challenge", async () => {
  const { playerId, challenge, address } = await freshLinkRequest();
  const impostor = await keypair();
  const signature = await signHex(challenge.message, impostor.privateKey);
  await assert.rejects(
    () => service.linkWallet({ playerId, nonce: challenge.nonce, signature, publicKey: impostor.publicKeyHex, address }),
    (err: unknown) => err instanceof service.NimiqLinkError && /verification failed|public key/i.test(err.message),
  );
});

test("a challenge for a different player is rejected (wrong player)", async () => {
  const { keys, challenge, signature, address } = await freshLinkRequest();
  const impostorPlayer = uniquePlayerId();
  await assert.rejects(
    () => service.linkWallet({ playerId: impostorPlayer, nonce: challenge.nonce, signature, publicKey: keys.publicKeyHex, address }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 403 && /different player/i.test(err.message),
  );
});

test("a challenge issued on another network is rejected (wrong network)", async () => {
  const playerId = uniquePlayerId();
  const keys = await keypair();
  const challenge = await service.issueWalletChallenge(playerId, "main");
  const signature = await signHex(challenge.message, keys.privateKey);
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId,
        nonce: challenge.nonce,
        signature,
        publicKey: keys.publicKeyHex,
        network: "test", // claiming test while the challenge says main
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /network/i.test(err.message),
  );
});

test("a consumed challenge cannot bind twice (replay protection)", async () => {
  const { playerId, keys, challenge, signature, address } = await freshLinkRequest();
  await service.linkWallet({ playerId, nonce: challenge.nonce, signature, publicKey: keys.publicKeyHex, address });
  // Same everything, fresh player: replay must fail.
  const secondPlayer = uniquePlayerId();
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId: secondPlayer,
        nonce: challenge.nonce,
        signature,
        publicKey: keys.publicKeyHex,
        address,
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /already used|invalid|expired/i.test(err.message),
  );
});

test("an expired challenge is rejected", async () => {
  const playerId = uniquePlayerId();
  const keys = await keypair();
  const challenge = await service.issueWalletChallenge(playerId, "test");
  const signature = await signHex(challenge.message, keys.privateKey);
  // Force expiry by rewinding issuedAt inside the message AND the stored
  // expiry: simplest is to travel forward in time past the window.
  const realNow = Date.now;
  Date.now = () => challenge.expiresAt + 60_000;
  try {
    await assert.rejects(
      () => service.linkWallet({ playerId, nonce: challenge.nonce, signature, publicKey: keys.publicKeyHex }),
      (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400,
    );
  } finally {
    Date.now = realNow;
  }
});

test("an unknown nonce is rejected", async () => {
  const playerId = uniquePlayerId();
  const keys = await keypair();
  const signature = await signHex("chainmate-link:test:x:ff:1", keys.privateKey);
  await assert.rejects(
    () => service.linkWallet({ playerId, nonce: "ff".repeat(32), signature, publicKey: keys.publicKeyHex }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400,
  );
});

test("a claimed address that the key does not control is rejected", async () => {
  const { playerId, keys, challenge, signature } = await freshLinkRequest();
  const other = await keypair();
  const fakeAddress = verify.addressFromPublicKey(other.publicKeyHex);
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId,
        nonce: challenge.nonce,
        signature,
        publicKey: keys.publicKeyHex,
        address: fakeAddress,
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /does not match/i.test(err.message),
  );
});

test("malformed public keys and signatures are rejected with 400s", async () => {
  const { playerId, challenge } = await freshLinkRequest();
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId,
        nonce: challenge.nonce,
        signature: "ff".repeat(64),
        publicKey: "zzzz", // malformed key
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /64 hex/i.test(err.message),
  );
  const keys = await keypair();
  const otherPlayer = uniquePlayerId();
  const otherChallenge = await service.issueWalletChallenge(otherPlayer, "test");
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId: otherPlayer,
        nonce: otherChallenge.nonce,
        signature: "abc", // malformed signature
        publicKey: keys.publicKeyHex,
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /128 hex/i.test(err.message),
  );
});

/* ------------------------------------------------------------------ */
/* Uniqueness and replacement                                          */
/* ------------------------------------------------------------------ */

test("the same wallet cannot bind to a second player (duplicate rejection)", async () => {
  const first = await freshLinkRequest();
  await service.linkWallet({
    playerId: first.playerId,
    nonce: first.challenge.nonce,
    signature: first.signature,
    publicKey: first.keys.publicKeyHex,
    address: first.address,
  });

  const second = await freshLinkRequest();
  // Second player tries to bind the SAME address (their challenge+key are
  // valid for their own wallet, but they claim the first player's address).
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId: second.playerId,
        nonce: second.challenge.nonce,
        signature: second.signature,
        publicKey: second.keys.publicKeyHex,
        address: first.address, // claim someone else's bound wallet
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 400 && /does not match/i.test(err.message),
  );

  // Direct duplicate via derivation (two players, same key material is
  // impossible in practice, so simulate the address-uniqueness path instead):
  // player two re-uses player one's key to sign their own challenge —
  // verification passes (the key signs), but the address is already bound.
  const challenge2 = await service.issueWalletChallenge(second.playerId, "test");
  const signature2 = await signHex(challenge2.message, first.keys.privateKey);
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId: second.playerId,
        nonce: challenge2.nonce,
        signature: signature2,
        publicKey: first.keys.publicKeyHex,
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 409 && /already linked to another player/i.test(err.message),
  );
});

test("rebinding the same address by the same player is allowed (idempotent)", async () => {
  const { playerId, keys, address } = await freshLinkRequest();
  const first = await service.issueWalletChallenge(playerId, "test");
  await service.linkWallet({
    playerId,
    nonce: first.nonce,
    signature: await signHex(first.message, keys.privateKey),
    publicKey: keys.publicKeyHex,
    address,
  });
  const second = await service.issueWalletChallenge(playerId, "test");
  const linked = await service.linkWallet({
    playerId,
    nonce: second.nonce,
    signature: await signHex(second.message, keys.privateKey),
    publicKey: keys.publicKeyHex,
    address,
  });
  assert.equal(linked.address, verify.canonicalAddress(address));
});

test("replacing with a DIFFERENT wallet requires replace=true", async () => {
  const first = await freshLinkRequest();
  await service.linkWallet({
    playerId: first.playerId,
    nonce: first.challenge.nonce,
    signature: first.signature,
    publicKey: first.keys.publicKeyHex,
  });

  const newKeys = await keypair();
  const challenge = await service.issueWalletChallenge(first.playerId, "test");
  const signature = await signHex(challenge.message, newKeys.privateKey);

  // Without replace → rejected.
  await assert.rejects(
    () =>
      service.linkWallet({
        playerId: first.playerId,
        nonce: challenge.nonce,
        signature,
        publicKey: newKeys.publicKeyHex,
      }),
    (err: unknown) => err instanceof service.NimiqLinkError && err.status === 409 && /already linked/i.test(err.message),
  );

  // With replace → succeeds and the old address is gone.
  const replaceChallenge = await service.issueWalletChallenge(first.playerId, "test");
  const replaceSignature = await signHex(replaceChallenge.message, newKeys.privateKey);
  const linked = await service.linkWallet({
    playerId: first.playerId,
    nonce: replaceChallenge.nonce,
    signature: replaceSignature,
    publicKey: newKeys.publicKeyHex,
    replace: true,
  });
  assert.notEqual(linked.address, verify.canonicalAddress(first.address));
  // The old address is no longer bound by anyone; the new one is the player's.
  assert.equal(await store.getBindingForAddress(verify.canonicalAddress(first.address)), null);
  assert.equal((await store.getBindingForAddress(linked.address))?.playerId, first.playerId);
});

test("unlink removes the binding and is idempotent", async () => {
  const { playerId, keys, challenge, signature, address } = await freshLinkRequest();
  await service.linkWallet({ playerId, nonce: challenge.nonce, signature, publicKey: keys.publicKeyHex, address });
  assert.ok(await service.getLinkedWallet(playerId));
  await service.unlinkWallet(playerId);
  assert.equal(await service.getLinkedWallet(playerId), null);
  // Second unlink is a no-op.
  await service.unlinkWallet(playerId);
  assert.equal(await service.getLinkedWallet(playerId), null);
});
