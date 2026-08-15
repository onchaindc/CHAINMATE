import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Built-in file-backed store used by the hosted multiplayer backend when no
 * Vercel KV keys are configured. Games are persisted as a single JSON file
 * under `.data/` (gitignored), so two players on different devices can join
 * the same game with zero setup — ideal for previews, containers and local
 * dev. When KV_REST_API_URL / KV_REST_API_TOKEN are set (production on
 * Vercel), lib/server/hosted.ts uses Vercel KV instead.
 *
 * Notes:
 *  - The file is shared by every request in this process (single-writer via a
 *    serialised write chain, atomic rename on disk).
 *  - On multi-instance serverless hosts without KV the file store is
 *    per-instance, so games can be lost between cold starts — that is exactly
 *    why production should use Vercel KV.
 */

const DATA_DIR = path.join(process.cwd(), ".data");
const GAMES_FILE = path.join(DATA_DIR, "games.json");

/** In-memory cache of the games file (object keyed by game id). */
let cache: Record<string, string> | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function readAll(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(GAMES_FILE, "utf8");
    cache = JSON.parse(raw) as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(all: Record<string, string>): Promise<void> {
  writeChain = writeChain
    .catch(() => {
      // A failed write must not poison the chain for later writes.
    })
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${GAMES_FILE}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all), "utf8");
      await fs.rename(tmp, GAMES_FILE);
    });
  return writeChain;
}

export async function fileGet(key: string): Promise<string | null> {
  const all = await readAll();
  return all[key] ?? null;
}

export async function fileSet(key: string, raw: string): Promise<void> {
  const all = await readAll();
  all[key] = raw;
  await persist(all);
}

export async function fileDelete(key: string): Promise<void> {
  const all = await readAll();
  delete all[key];
  await persist(all);
}

export function fileConfigured(): boolean {
  return true;
}
