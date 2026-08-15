"use client";

import { getGameBackend, isGenLayerGameId, isHostedGameId, isLocalGameId } from "@/lib/config";
import type { GameBackend, GameStore } from "@/lib/types";
import { GenLayerGameStore } from "@/lib/store/genlayer-store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import { LocalGameStore } from "@/lib/store/local-store";

let localStore: LocalGameStore | null = null;
let hostedStore: HostedGameStore | null = null;
let genLayerStore: GenLayerGameStore | null = null;

export function getStore(backend?: GameBackend): GameStore {
  const which = backend ?? getGameBackend();
  if (which === "genlayer") {
    if (!genLayerStore) genLayerStore = new GenLayerGameStore();
    return genLayerStore;
  }
  if (which === "hosted") {
    if (!hostedStore) hostedStore = new HostedGameStore();
    return hostedStore;
  }
  if (!localStore) localStore = new LocalGameStore();
  return localStore;
}

/** Pick the store that owns a game id (ids carry a backend prefix). */
export function getStoreForId(id: string): GameStore {
  if (isGenLayerGameId(id)) return getStore("genlayer");
  if (isLocalGameId(id)) return getStore("local");
  if (isHostedGameId(id)) return getStore("hosted");
  return getStore();
}
