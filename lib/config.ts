import type { GameBackend } from "@/lib/types";

/**
 * Client-safe configuration. NEXT_PUBLIC_* variables are inlined at
 * build time, so this module can be imported from client components.
 */

export function getGameBackend(): GameBackend {
  const value = process.env.NEXT_PUBLIC_GAME_BACKEND;
  return value === "genlayer" ? "genlayer" : "local";
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

/** Local game ids are prefixed so the app knows which store owns them. */
export const LOCAL_GAME_PREFIX = "local_";

export function isLocalGameId(id: string): boolean {
  return id.startsWith(LOCAL_GAME_PREFIX);
}

export function isGenLayerGameId(id: string): boolean {
  return /^0x[0-9a-fA-F]{40,64}$/.test(id) || id.startsWith("genlayer_");
}
