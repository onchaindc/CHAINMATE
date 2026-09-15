// Server-only module — never import from client components.

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Read a legacy raw JSON data file from the old `.data/<name>` store used
 * before the B2 storage unification. Returns null when absent/unreadable —
 * callers treat that as "nothing to migrate". This module is read-only: it
 * never writes or deletes, so a failed migration can always be retried.
 */
export function readFileSafe(name: string): string | null {
  try {
    return readFileSync(path.join(process.cwd(), ".data", name), "utf8");
  } catch {
    return null;
  }
}
