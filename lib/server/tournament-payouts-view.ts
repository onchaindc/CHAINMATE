// Server-only module — never import from client components.

/**
 * Small read-view helper so the payouts route can rebuild final standings
 * from a stored document without importing the whole engine graph.
 */

import type { TournamentDocument } from "@/lib/server/tournament-store";
import {
  computeKnockoutStandings,
  computeStandings,
} from "@/lib/tournament-standings";
import type { StandingRow } from "@/lib/tournament-types";

/** Active (non-withdrawn) entries of a document. */
function activeEntries(doc: TournamentDocument) {
  return doc.entries.filter((e) => e.leftAt === undefined);
}

/** The same recomputation the engine uses (deterministic standings). */
export function recomputeStandingsFor(doc: TournamentDocument): StandingRow[] {
  if (doc.format === "knockout") {
    return computeKnockoutStandings(doc.matches, activeEntries(doc));
  }
  return computeStandings(doc.format, doc.matches, activeEntries(doc));
}
