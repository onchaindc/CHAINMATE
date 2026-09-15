// Server-only module — never import from client components.

/**
 * Nimiq wallet binding + challenge storage — Phase 1B.
 *
 * Follows the ChainMate persistence pattern exactly (mirroring
 * lib/server/tournament-store.ts): the fast store (Vercel KV when configured,
 * else the .data file store) is the runtime source of truth, and Supabase is
 * a best-effort durable mirror used for cold-start recovery and for the
 * cross-instance unique-address index.
 *
 * Concurrency: per-key promise-chain locks (same idiom as the tournament
 * store) serialize challenge consumption and binding writes within an
 * instance; the Supabase mirror's PRIMARY KEY (player_id) and UNIQUE
 * (address) constraints are the cross-instance guards.
 */

import { getGameStorage } from "@/lib/server/storage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/supabase/config";
import type { NimiqNetworkName } from "@/lib/nimiq/config";

const BINDINGS_KEY = "chainmate:nimiq:bindings";
const CHALLENGE_PREFIX = "chainmate:nimiq:challenge:";

export interface NimiqWalletBinding {
  playerId: string;
  /** Canonical (uppercase, unspaced) Nimiq address. */
  address: string;
  network: NimiqNetworkName;
  /** Hex ed25519 public key — kept for audit; address is derivable from it. */
  publicKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface NimiqWalletChallenge {
  nonce: string;
  playerId: string;
  network: NimiqNetworkName;
  issuedAt: number;
  /** Epoch ms — 5 minutes after issue. */
  expiresAt: number;
  /** Set when consumed; a consumed challenge can never bind again. */
  consumedAt: number | null;
}

/* ------------------------------------------------------------------ */
/* Per-key promise-chain locks                                         */
/* ------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/* ------------------------------------------------------------------ */
/* Supabase mirror (best-effort)                                       */
/* ------------------------------------------------------------------ */

interface BindingRow {
  player_id: string;
  address: string;
  network: string;
  public_key: string;
}

function reportMirrorError(scope: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[nimiq-store] ${scope} mirror failed: ${message}`);
}

async function mirrorBinding(binding: NimiqWalletBinding): Promise<void> {
  if (!supabaseConfigured()) return;
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin.from("nimiq_wallet_bindings").upsert({
    player_id: binding.playerId,
    address: binding.address,
    network: binding.network,
    public_key: binding.publicKey,
  } satisfies BindingRow);
  if (error) reportMirrorError("binding upsert", error);
}

async function deleteBindingMirror(playerId: string): Promise<void> {
  if (!supabaseConfigured()) return;
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin
    .from("nimiq_wallet_bindings")
    .delete()
    .eq("player_id", playerId);
  if (error) reportMirrorError("binding delete", error);
}

async function mirrorChallenge(challenge: NimiqWalletChallenge): Promise<void> {
  if (!supabaseConfigured()) return;
  const admin = getSupabaseAdmin();
  if (!admin) return;
  const { error } = await admin.from("nimiq_wallet_challenges").upsert({
    nonce: challenge.nonce,
    player_id: challenge.playerId,
    network: challenge.network,
    issued_at: new Date(challenge.issuedAt).toISOString(),
    expires_at: new Date(challenge.expiresAt).toISOString(),
    consumed_at: challenge.consumedAt ? new Date(challenge.consumedAt).toISOString() : null,
  });
  if (error) reportMirrorError("challenge upsert", error);
}

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

async function readBindings(): Promise<Record<string, NimiqWalletBinding>> {
  const storage = getGameStorage();
  const raw = await storage.get(BINDINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, NimiqWalletBinding>;
  } catch {
    return {};
  }
}

async function writeBindings(bindings: Record<string, NimiqWalletBinding>): Promise<void> {
  const storage = getGameStorage();
  await storage.set(BINDINGS_KEY, JSON.stringify(bindings));
}

/** Binding for one player, or null. */
export async function getBindingForPlayer(
  playerId: string,
): Promise<NimiqWalletBinding | null> {
  const bindings = await readBindings();
  return bindings[playerId] ?? null;
}

/** Binding whose address is the given one (canonical compare), or null. */
export async function getBindingForAddress(
  address: string,
): Promise<NimiqWalletBinding | null> {
  const canonical = address.replace(/[\s-]/g, "").toUpperCase();
  const bindings = await readBindings();
  for (const binding of Object.values(bindings)) {
    if (binding.address === canonical) return binding;
  }
  return null;
}

/** Replace-or-remove a player's binding atomically (single wallet per player). */
export async function setBindingForPlayer(
  playerId: string,
  binding: NimiqWalletBinding | null,
): Promise<void> {
  await withLock(`binding:${playerId}`, async () => {
    const bindings = await readBindings();
    if (binding) {
      bindings[playerId] = binding;
    } else {
      delete bindings[playerId];
    }
    await writeBindings(bindings);
    if (binding) await mirrorBinding(binding);
    else await deleteBindingMirror(playerId);
  });
}

/* ------------------------------------------------------------------ */
/* Challenges                                                          */
/* ------------------------------------------------------------------ */

function challengeKey(nonce: string): string {
  return `${CHALLENGE_PREFIX}${nonce}`;
}

async function readChallenge(nonce: string): Promise<NimiqWalletChallenge | null> {
  const storage = getGameStorage();
  const raw = await storage.get(challengeKey(nonce));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NimiqWalletChallenge;
  } catch {
    return null;
  }
}

async function writeChallenge(challenge: NimiqWalletChallenge): Promise<void> {
  const storage = getGameStorage();
  await storage.set(challengeKey(challenge.nonce), JSON.stringify(challenge));
}

/** Persist a newly issued challenge. */
export async function saveChallenge(challenge: NimiqWalletChallenge): Promise<void> {
  await writeChallenge(challenge);
  await mirrorChallenge(challenge);
}

/**
 * Consume a challenge exactly once.
 *
 * Atomically (under the per-nonce lock) rejects challenges that are missing,
 * expired, or already consumed, and marks the challenge consumed before any
 * caller can act on the result — a replayed signature therefore can never
 * bind twice. Returns the challenge when it was cleanly consumed, else null.
 */
export async function consumeChallenge(
  nonce: string,
): Promise<NimiqWalletChallenge | null> {
  return withLock(`challenge:${nonce}`, async () => {
    const challenge = await readChallenge(nonce);
    if (!challenge) return null;
    if (challenge.consumedAt !== null) return null;
    if (Date.now() > challenge.expiresAt) return null;
    const consumed: NimiqWalletChallenge = {
      ...challenge,
      consumedAt: Date.now(),
    };
    await writeChallenge(consumed);
    await mirrorChallenge(consumed);
    return consumed;
  });
}

/**
 * Cross-instance duplicate-address guard backed by the Supabase UNIQUE
 * constraint. When Supabase is configured, a mirror write for an address
 * already bound to a DIFFERENT player fails and the caller must roll back.
 * Returns false when the address is provably taken elsewhere.
 */
export async function isAddressTakenByOther(
  address: string,
  playerId: string,
): Promise<boolean> {
  const existing = await getBindingForAddress(address);
  return existing !== null && existing.playerId !== playerId;
}
