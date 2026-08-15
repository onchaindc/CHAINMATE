"use client";

import { getGameBackend, isGenLayerGameId, isLocalGameId } from "@/lib/config";
import type { GameBackend, GameStore } from "@/lib/types";
import { GenLayerGameStore } from "@/lib/store/genlayer-store";
import { LocalGameStore } from "@/lib/store/local-store";

let localStore: LocalGameStore | null = null;
let genLayerStore: GenLayerGameStore | null = null;

export function getStore(backend?: GameBackend): GameStore {
  const which = backend ?? getGameBackend();
  if (which === "genlayer") {
    if (!genLayerStore) genLayerStore = new GenLayerGameStore();
    return genLayerStore;
  }
  if (!localStore) localStore = new LocalGameStore();
  return localStore;
}

/** Pick the store that owns a game id (local ids start with "local_"). */
export function getStoreForId(id: string): GameStore {
  if (isGenLayerGameId(id)) return getStore("genlayer");
  if (isLocalGameId(id)) return getStore("local");
  return getStore();
}
