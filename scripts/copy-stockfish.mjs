#!/usr/bin/env node
/**
 * Keep the WASM engine in /public/stockfish in sync with the stockfish.js
 * package — the single source of truth for the engine binary. Run it after
 * upgrading stockfish.js in package.json:
 *
 *     npm run engine:sync
 *
 * Exit code 0 with both files present and byte-identical; fails loudly when
 * the public copies drift from the package.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "stockfish.js");
const dest = join(root, "public", "stockfish");

const FILES = ["stockfish.wasm.js", "stockfish.wasm"];

mkdirSync(dest, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(src, file), join(dest, file));
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const file of FILES) {
  const a = sha(join(src, file));
  const b = sha(join(dest, file));
  if (a !== b) {
    console.error(`engine:sync — ${file} in public/stockfish does not match the package`);
    process.exit(1);
  }
}
console.log(`engine:sync — Stockfish WASM copied to public/stockfish and verified`);
