/**
 * Payment-intent proof of signer — regression tests.
 *
 * Pins the three invariants of the sender-mismatch fix:
 *
 *   1. encode/decode round-trips (including the hex/hex-of-hex encodings the
 *      SDK→node stack may produce),
 *   2. a proof signed by the linked wallet's key over the EXACT server-side
 *      intent verifies,
 *   3. ANY deviation — different key, different amount, different recipient,
 *      different player, different tournament, different network — is
 *      rejected. The server reconstructs the intent itself, so a proof can
 *      only ever attest to the payment it was issued for.
 *
 * Uses REAL Ed25519 keys and the REAL Nimiq message-signing convention
 * (the same one Nimiq Pay applies), via the Phase 1B verify module.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

import type * as ProofModule from "@/lib/nimiq/proof";
import type { PaymentIntent } from "@/lib/nimiq/proof";
import type * as ServerVerifyModule from "@/lib/server/nimiq/verify";
import type * as ServerProofModule from "@/lib/server/nimiq/proof";

let proof: typeof ProofModule;
let serverVerify: typeof ServerVerifyModule;
let serverProof: typeof ServerProofModule;

// @noble/ed25519 v2 application-supplied hashing (same as the app modules).
ed.etc.sha512Async = async (m: Uint8Array) => sha512(m);
ed.etc.sha512Sync = (m: Uint8Array) => sha512(m);

const LINKED = "NQ64 66X5 1RHD 3TE7 X1XJ QSLC FL8X 17JA QB93";
const OTHER = "NQ11 2222 3334 4444 5555 6666 7777 8888 9999";
const TREASURY = "NQ09 8765 4321 0987 6543 2109 8765 4321 0987";

async function keypair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKeyHex: Buffer.from(pub).toString("hex") };
}

/** Sign like Nimiq Pay does: SHA-256 over the framed message, then Ed25519. */
async function signHex(message: string, privateKey: Uint8Array): Promise<string> {
  const signed = serverVerify.nimiqMessageSigningHash(message);
  const sig = await ed.signAsync(signed, privateKey);
  return Buffer.from(sig).toString("hex");
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "chainmate-proof-"));
  process.chdir(root);
  proof = await import("@/lib/nimiq/proof");
  serverVerify = await import("@/lib/server/nimiq/verify");
  serverProof = await import("@/lib/server/nimiq/proof");
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

const INTENT: PaymentIntent = {
  playerId: "acct_proof_1",
  tournamentId: "tour_proof_1",
  amountLuna: "10000000", // 100 NIM
  recipient: TREASURY.replace(/\s/g, ""),
  network: "test",
};

test("proof message is deterministic and parseable", () => {
  const m1 = proof.proofMessage(INTENT);
  const m2 = proof.proofMessage({ ...INTENT });
  assert.equal(m1, m2);
  const parsed = proof.parseProofMessage(m1);
  assert.deepEqual(parsed, INTENT);
});

test("parseProofMessage rejects malformed intents", () => {
  assert.equal(proof.parseProofMessage("garbage"), null);
  assert.equal(proof.parseProofMessage("CM2-PAY|main|p|t|abc|NQXX"), null); // bad amount
  assert.equal(proof.parseProofMessage("OTHER|test|p|t|1|NQXX"), null); // bad marker
});

test("encode/decode round-trips through ASCII and hex forms", () => {
  const p = { publicKey: "a".repeat(64), signature: "b".repeat(128) };
  const ascii = proof.encodeProofData(p);
  assert.match(ascii, /^CM2-PAY:[0-9a-f]{64}:[0-9a-f]{128}$/);
  assert.deepEqual(proof.decodeProofData(ascii), p);

  // The wire form: hex-encoded ASCII.
  const hex = proof.encodeProofDataHex(p);
  assert.equal(hex, Buffer.from(ascii, "utf8").toString("hex"));
  assert.deepEqual(proof.decodeProofData(hex), p);

  // A node that re-encodes the hex string as hex again (hex of hex).
  const hexOfHex = Buffer.from(hex, "utf8").toString("hex");
  assert.deepEqual(proof.decodeProofData(hexOfHex), p);

  // 0x prefix tolerated.
  assert.deepEqual(proof.decodeProofData(`0x${hex}`), p);

  // No proof in unrelated data.
  assert.equal(proof.decodeProofData("hello world"), null);
  assert.equal(proof.decodeProofData(""), null);
  assert.equal(proof.decodeProofData(null), null);
  assert.equal(proof.decodeProofData(undefined), null);
  assert.equal(proof.decodeProofData(42), null);
});

test("a REAL signature by the linked wallet's key verifies against the server intent", async () => {
  // The linked address is DERIVED from the key (Phase 1B rule): whatever
  // keypair this test generates, its Blake2b address IS the linked wallet.
  const { privateKey, publicKeyHex } = await keypair();
  const linkedAddress = serverVerify.addressFromPublicKey(publicKeyHex);
  const message = proof.proofMessage(INTENT);
  const signature = await signHex(message, privateKey);

  const verdict = await serverProof.verifyPaymentProof(
    { publicKey: publicKeyHex, signature },
    {
      playerId: INTENT.playerId,
      tournamentId: INTENT.tournamentId,
      expectedAmountLuna: BigInt(INTENT.amountLuna),
      expectedRecipient: INTENT.recipient,
      network: INTENT.network,
      linkedAddress,
    },
  );
  assert.deepEqual(verdict, { ok: true });
});

test("the keypair's derived address must equal the claimed linked address for the test to be honest", async () => {
  // The server binds address = Blake2b(pubkey); for the acceptance test the
  // keypair must actually BE the linked wallet's key. Generate a keypair and
  // use ITS derived address as the linked address end-to-end.
  const { privateKey, publicKeyHex } = await keypair();
  const linkedAddress = serverVerify.addressFromPublicKey(publicKeyHex);
  const message = proof.proofMessage(INTENT);
  const signature = await signHex(message, privateKey);

  const ok = await serverProof.verifyPaymentProof(
    { publicKey: publicKeyHex, signature },
    {
      playerId: INTENT.playerId,
      tournamentId: INTENT.tournamentId,
      expectedAmountLuna: BigInt(INTENT.amountLuna),
      expectedRecipient: INTENT.recipient,
      network: INTENT.network,
      linkedAddress,
    },
  );
  assert.deepEqual(ok, { ok: true });

  // The SAME proof against a DIFFERENT linked wallet is rejected as
  // key-not-linked-wallet — the cryptographic core of the fix.
  const bad = await serverProof.verifyPaymentProof(
    { publicKey: publicKeyHex, signature },
    {
      playerId: INTENT.playerId,
      tournamentId: INTENT.tournamentId,
      expectedAmountLuna: BigInt(INTENT.amountLuna),
      expectedRecipient: INTENT.recipient,
      network: INTENT.network,
      linkedAddress: serverVerify.addressFromPublicKey((await keypair()).publicKeyHex),
    },
  );
  assert.equal(ok.ok && bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "key-not-linked-wallet");
});

test("any intent deviation is rejected (amount, recipient, player, tournament, network)", async () => {
  const { privateKey, publicKeyHex } = await keypair();
  const linkedAddress = serverVerify.addressFromPublicKey(publicKeyHex);
  const message = proof.proofMessage(INTENT);
  const signature = await signHex(message, privateKey);

  const expectReject = async (overrides: Partial<typeof INTENT>) => {
    const deviated = { ...INTENT, ...overrides };
    const verdict = await serverProof.verifyPaymentProof(
      { publicKey: publicKeyHex, signature },
      {
        playerId: deviated.playerId,
        tournamentId: deviated.tournamentId,
        expectedAmountLuna: BigInt(deviated.amountLuna),
        expectedRecipient: deviated.recipient,
        network: deviated.network,
        linkedAddress,
      },
    );
    assert.equal(verdict.ok, false, `expected rejection for ${JSON.stringify(overrides)}`);
    if (!verdict.ok) assert.equal(verdict.reason, "signature-invalid");
  };

  await expectReject({ amountLuna: "99000000" }); // different fee
  await expectReject({ recipient: OTHER.replace(/\s/g, "") }); // different treasury
  await expectReject({ playerId: "acct_other" }); // different player
  await expectReject({ tournamentId: "tour_other" }); // different tournament
  await expectReject({ network: "main" }); // different network
});

test("a signature by a DIFFERENT key never verifies", async () => {
  const { publicKeyHex } = await keypair();
  const attacker = await keypair();
  const message = proof.proofMessage(INTENT);
  const signature = await signHex(message, attacker.privateKey);

  const verdict = await serverProof.verifyPaymentProof(
    { publicKey: publicKeyHex, signature }, // claims the linked key…
    {
      playerId: INTENT.playerId,
      tournamentId: INTENT.tournamentId,
      expectedAmountLuna: BigInt(INTENT.amountLuna),
      expectedRecipient: INTENT.recipient,
      network: INTENT.network,
      linkedAddress: serverVerify.addressFromPublicKey(publicKeyHex),
    },
  );
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "signature-invalid");
});

test("garbage proofs fail closed as malformed", async () => {
  const linkedAddress = LINKED.replace(/\s/g, "");
  const verdict = await serverProof.verifyPaymentProof(
    { publicKey: "zz", signature: "yy" },
    {
      playerId: INTENT.playerId,
      tournamentId: INTENT.tournamentId,
      expectedAmountLuna: 1n,
      expectedRecipient: INTENT.recipient,
      network: "test",
      linkedAddress,
    },
  );
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "malformed-proof");
});
