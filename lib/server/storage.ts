import { kvConfigured, kvDelete, kvGetString, kvSetString } from "@/lib/server/kv";
import { fileDelete, fileGet, fileSet } from "@/lib/server/file-store";

/**
 * Key/value storage for hosted games.
 *
 * The hosted backend (lib/server/hosted.ts) uses this abstraction so
 * multiplayer works out of the box:
 *  - Vercel KV (KV_REST_API_URL + KV_REST_API_TOKEN) when configured — the
 *    production path on Vercel.
 *  - A built-in file store (.data/games.json) otherwise — zero-config
 *    cross-device play in previews and containers.
 */

export interface GameStorage {
  get(key: string): Promise<string | null>;
  set(key: string, raw: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const kvStorage: GameStorage = {
  async get(key) {
    return kvGetString(key);
  },
  async set(key, raw) {
    await kvSetString(key, raw);
  },
  async delete(key) {
    await kvDelete(key);
  },
};

const fileStorage: GameStorage = {
  async get(key) {
    return fileGet(key);
  },
  async set(key, raw) {
    await fileSet(key, raw);
  },
  async delete(key) {
    await fileDelete(key);
  },
};

export function getGameStorage(): GameStorage {
  return kvConfigured() ? kvStorage : fileStorage;
}
