// Server-only module — never import from client components.

/**
 * Nimiq wallet linking service — Phase 1B.
 *
 * Orchestrates the full bind pipeline on top of the Phase 1A primitives
 * (config/format/miniapp) and the Phase 1B crypto + storage modules. Every
 * rejection in the brief is enforced here:
 *
 *  - challenge must exist, be unconsumed, unexpired, for the right player
 *    AND network (consumeChallenge() makes single-use atomic)
 *  - signature must verify over the exact deterministic message
 *  - public key must be well-formed; the address checked against the wallet
 *    is re-derived FROM the public key, so a client cannot claim an address
 *    its key does not control
 *  - an address already bound to another player is rejected
 *  - a player with an existing binding must explicitly replace or remove it
 *
 * The client never picks any part of the identity: address comes from the
 * key, the key comes from the signature, the signature comes from a
 * server-issued challenge.
 */

import { NIMIQ_NETWORK, type NimiqNetworkName } from "@/lib/nimiq/config";
import {
  NimiqVerifyError,
  addressFromPublicKey,
  canonicalAddress,
  challengeMessage,
  generateChallengeNonce,
  verifyChallengeSignature,
} from "@/lib/server/nimiq/verify";
import {
  consumeChallenge,
  getBindingForPlayer,
  isAddressTakenByOther,
  saveChallenge,
  setBindingForPlayer,
  type NimiqWalletBinding,
} from "@/lib/server/nimiq/store";

/** Challenge lifetime: 5 minutes, per the brief. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Consistent error shape for the API routes to translate into responses. */
export class NimiqLinkError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "NimiqLinkError";
    this.status = status;
  }
}

/** The payload returned by a challenge request. */
export interface NimiqChallenge {
  network: NimiqNetworkName;
  playerId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** The exact string the wallet must sign. */
  message: string;
}

/** Issue a fresh single-use challenge for the authenticated player. */
export async function issueWalletChallenge(
  playerId: string,
  network?: NimiqNetworkName,
): Promise<NimiqChallenge> {
  const chosen = network ?? NIMIQ_NETWORK;
  const issuedAt = Date.now();
  const nonce = generateChallengeNonce();
  const challenge: NimiqChallenge = {
    network: chosen,
    playerId,
    nonce,
    issuedAt,
    expiresAt: issuedAt + CHALLENGE_TTL_MS,
    message: challengeMessage({
      network: chosen,
      playerId,
      nonce,
      issuedAt,
    }),
  };
  await saveChallenge({
    nonce,
    playerId,
    network: chosen,
    issuedAt,
    expiresAt: challenge.expiresAt,
    consumedAt: null,
  });
  return challenge;
}

export interface LinkWalletInput {
  playerId: string;
  /** Signature over the challenge message (hex, 128 chars). */
  signature: string;
  /** Hex ed25519 public key (64 chars) matching the signer. */
  publicKey: string;
  /**
   * Address the client DISPLAYS. It is not trusted: it must equal the
   * address re-derived from the verified public key.
   */
  address?: string;
  nonce: string;
  network?: NimiqNetworkName;
  /** Explicitly allow replacing a DIFFERENT already-linked wallet. */
  replace?: boolean;
}

/** Result of a successful bind. */
export type NimiqLinkedWallet = Readonly<{
  address: string;
  network: NimiqNetworkName;
  linkedAt: number;
}>;

/**
 * Verify a signed challenge and bind the wallet to the player.
 * Throws NimiqLinkError with an appropriate status on every rejection path.
 */
export async function linkWallet(input: LinkWalletInput): Promise<NimiqLinkedWallet> {
  // 1. Shape checks first — cheap rejections before any I/O.
  const claimedAddress = input.address ? canonicalAddress(input.address) : null;
  const network = input.network ?? NIMIQ_NETWORK;
  if (!input.nonce) throw new NimiqLinkError("Challenge nonce is required", 400);

  // 2. Consume the challenge atomically — existence, expiry, single-use.
  const challenge = await consumeChallenge(input.nonce);
  if (!challenge) {
    throw new NimiqLinkError("Challenge is invalid, expired, or already used", 400);
  }
  if (challenge.playerId !== input.playerId) {
    throw new NimiqLinkError("Challenge was issued to a different player", 403);
  }
  if (challenge.network !== network) {
    throw new NimiqLinkError(
      `Challenge was issued for network "${challenge.network}"`,
      400,
    );
  }

  // 3. Verify the signature over the exact message.
  const message = challengeMessage({
    network: challenge.network,
    playerId: challenge.playerId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
  });
  let signatureValid = false;
  try {
    signatureValid = await verifyChallengeSignature({
      message,
      signatureHex: input.signature,
      publicKeyHex: input.publicKey,
    });
  } catch (err) {
    throw new NimiqLinkError(
      err instanceof NimiqVerifyError ? err.message : "Malformed signature or public key",
      400,
    );
  }
  if (!signatureValid) {
    throw new NimiqLinkError("Signature verification failed", 400);
  }

  // 4. Derive the address FROM the verified key — the client's claim is
  //    only allowed to agree, never to define.
  const derivedAddress = canonicalAddress(addressFromPublicKey(input.publicKey));
  if (claimedAddress && claimedAddress !== derivedAddress) {
    throw new NimiqLinkError(
      "Address does not match the wallet's public key",
      400,
    );
  }

  // 5. Uniqueness: the address must not belong to another player.
  if (await isAddressTakenByOther(derivedAddress, input.playerId)) {
    throw new NimiqLinkError("This wallet is already linked to another player", 409);
  }

  // 6. Replacement semantics: one wallet per player. A silent re-link over
  //    an existing wallet is rejected — the client must replace=true (or
  //    unlink first). Re-linking the SAME address is idempotent-friendly.
  const existing = await getBindingForPlayer(input.playerId);
  if (existing && existing.address !== derivedAddress && !input.replace) {
    throw new NimiqLinkError(
      "A different wallet is already linked, unlink it first or pass replace",
      409,
    );
  }

  const now = Date.now();
  const binding: NimiqWalletBinding = {
    playerId: input.playerId,
    address: derivedAddress,
    network,
    publicKey: input.publicKey.toLowerCase(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await setBindingForPlayer(input.playerId, binding);

  return {
    address: binding.address,
    network: binding.network,
    linkedAt: binding.createdAt,
  };
}

/** The player's linked wallet, or null. */
export async function getLinkedWallet(
  playerId: string,
): Promise<NimiqLinkedWallet | null> {
  const binding = await getBindingForPlayer(playerId);
  if (!binding) return null;
  return {
    address: binding.address,
    network: binding.network,
    linkedAt: binding.createdAt,
  };
}

/** Remove the player's wallet binding (idempotent). */
export async function unlinkWallet(playerId: string): Promise<void> {
  await setBindingForPlayer(playerId, null);
}
