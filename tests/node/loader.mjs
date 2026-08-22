/**
 * ESM resolve hook for the `@/…` path alias declared in tsconfig.json.
 *
 * Node runs the TypeScript sources directly (it strips types natively from
 * v22.6), but it knows nothing about tsconfig `paths`, so `@/lib/server/hosted`
 * would fail to resolve. This maps the alias onto the project root and tries
 * the extensions TypeScript would, which is all the app's own imports need.
 *
 * Registered via `node --import ./tests/node/register.mjs`.
 */

import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/* This file lives at <root>/tests/node/loader.mjs. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* Order matters: `.ts` must win over a stale build artefact of the same name,
   and a directory import must land on its index file. */
const CANDIDATES = [
  (p) => p,
  (p) => `${p}.ts`,
  (p) => `${p}.tsx`,
  (p) => path.join(p, "index.ts"),
  (p) => path.join(p, "index.tsx"),
  (p) => `${p}.js`,
  (p) => `${p}.mjs`,
];

function resolveFile(base) {
  for (const candidate of CANDIDATES) {
    const file = candidate(base);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // does not exist — try the next extension
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const file = resolveFile(path.join(ROOT, specifier.slice(2)));
    if (!file) throw new Error(`Could not resolve "${specifier}" under ${ROOT}`);
    return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
