import type { GameBackend } from "@/lib/types";

/**
 * Client-safe configuration. NEXT_PUBLIC_* variables are inlined at
 * build time, so this module can be imported from client components.
 *
 * Modes:
 *  - "local":   games live in this browser (localStorage) — same-browser play
 *  - "hosted":  games live in a shared server store — cross-device (default;
 *               Vercel KV when configured, otherwise a built-in file store)
 *  - "genlayer": games are ChainMate contracts on the GenLayer network
 */

export function getGameBackend(): GameBackend {
  const value = process.env.NEXT_PUBLIC_GAME_BACKEND;
  if (value === "genlayer") return "genlayer";
  if (value === "hosted") return "hosted";
  if (value === "local") return "local";
  // Default: shared multiplayer. A game created here works from any device
  // (the server store persists it), so friends never hit "Game not found".
  return "hosted";
}

export const GENLAYER_NETWORK: string =
  process.env.NEXT_PUBLIC_GENLAYER_NETWORK ?? "testnetBradbury";

export const GENLAYER_RPC_URL: string | undefined =
  process.env.NEXT_PUBLIC_GENLAYER_RPC_URL || undefined;

/** Enable LLM-enhanced commentary/summary in the UI (needs AI_API_KEY server-side). */
export const AI_ENABLED: boolean =
  process.env.NEXT_PUBLIC_AI_ENABLED === "true";

/** A locally-generated identity used by the built-in local game store. */
export const LOCAL_PLAYER_KEY = "chainmate:player-id";

/** Persistent identity used by the hosted multiplayer store. */
export const HOSTED_PLAYER_KEY = "chainmate:hosted:player-id";

/** Local game ids are prefixed so the app knows which store owns them. */
export const LOCAL_GAME_PREFIX = "local_";

/** Hosted game ids are prefixed so the app knows which store owns them. */
export const HOSTED_GAME_PREFIX = "hosted_";

export function isLocalGameId(id: string): boolean {
  return id.startsWith(LOCAL_GAME_PREFIX);
}

export function isHostedGameId(id: string): boolean {
  return id.startsWith(HOSTED_GAME_PREFIX);
}

export function isGenLayerGameId(id: string): boolean {
  // GenLayer contract addresses are 0x + 40 hex chars. A 64-char value is a
  // transaction hash, not a contract — never treat those as game ids.
  return /^0x[0-9a-fA-F]{40}$/.test(id) || id.startsWith("genlayer_");
}
