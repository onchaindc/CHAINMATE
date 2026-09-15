/**
 * Deterministic tournament standings — ChainMate Phase 2A.
 *
 * Pure functions over match results. No I/O, no time, no randomness: the same
 * match list always produces the same table, so the server can recompute
 * standings after every game result and every viewer agrees.
 *
 * SCORING RULES (exact, per format)
 * ---------------------------------
 * Win = 1 point, Draw = ½ (0.5), Loss = 0. Internally points are kept as
 * integers doubled (pointsX2), so ½ is 1 and comparisons stay exact — no
 * floating-point ties.
 *
 * Swiss bye: a player paired against nobody (odd field) is recorded as a
 * marker match against SWISS_BYE_OPPONENT. It awards 1 point but does NOT
 * count as a game played, does not count as a win for tiebreaks, and adds
 * nothing to anyone's Buchholz.
 *
 *  • SWISS ranking keys, applied in order (all deterministic, no randomness):
 *      1. points            (higher first)
 *      2. Buchholz          — sum of each opponent's final points (higher first)
 *      3. wins              (higher first)
 *      4. head-to-head      — the direct game between the two tied players,
 *                             only when they met once and one beat the other
 *      5. player id ascending — absolute last resort, so the table is always
 *                             reproducible rather than arbitrary.
 *
 *  • ARENA ranking keys (players may meet repeatedly during the window):
 *      1. points            (higher first)
 *      2. win rate          — wins/played, compared exactly as the integer
 *                             floor(wins·1000/played); a player with zero
 *                             games ranks below every player with a game
 *      3. Buchholz          (higher first)
 *      4. player id ascending.
 *
 *  • KNOCKOUT standings reflect elimination/finishing position, not points:
 *      the final winner is rank 1, the runner-up rank 2, earlier eliminations
 *      fill the ranks below in reverse round order. Within one round, the
 *      loser beaten by the eventual champion ranks above the other loser of
 *      that round. Points still carry W/D/L for display. Abandoned matches
 *      (aborted games) advance the better seed — see the engine.
 *
 * Shared ranks: rows that compare exactly equal (the comparator returns 0)
 * get the same rank number; the next different row gets its position.
 *
 * Exported and unit-tested in tests/node/tournaments.test.ts.
 */

import {
  type StandingRow,
  type TournamentEntry,
  type TournamentFormat,
  type TournamentMatch,
} from "@/lib/tournament-types";
import { SWISS_BYE_OPPONENT } from "@/lib/tournament-types";

/** Internal exact score: win 2, draw 1, loss 0 (halves without floats). */
export type ScoreX2 = 0 | 1 | 2;

export function scoreForX2(result: "white" | "black" | "draw"): [ScoreX2, ScoreX2] {
  if (result === "draw") return [1, 1];
  return result === "white" ? [2, 0] : [0, 2];
}

interface Accumulator {
  playerId: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  pointsX2: number;
  /** Opponent ids actually played (byes excluded) — for Buchholz and H2H. */
  opponents: string[];
  /** Player ids this player beat — for head-to-head. */
  beat: Set<string>;
}

function blank(playerId: string): Accumulator {
  return {
    playerId,
    played: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    pointsX2: 0,
    opponents: [],
    beat: new Set(),
  };
}

/** Only completed matches with a result count. Pending/active are invisible. */
function completedMatches(matches: TournamentMatch[]): TournamentMatch[] {
  return matches.filter((m) => m.status === "complete" && m.result);
}

/**
 * Build the raw accumulators for every listed player (entries first; players
 * who appear in a completed match are added on demand so a withdrawn player
 * keeps their record).
 */
function accumulate(
  matches: TournamentMatch[],
  playerIds: string[],
): Map<string, Accumulator> {
  const acc = new Map<string, Accumulator>();
  for (const id of playerIds) if (!acc.has(id)) acc.set(id, blank(id));
  for (const m of completedMatches(matches)) {
    // Swiss bye marker: one free point, not a game.
    if (m.whitePlayerId && m.blackPlayerId === SWISS_BYE_OPPONENT) {
      const bye = acc.get(m.whitePlayerId) ?? blank(m.whitePlayerId);
      bye.pointsX2 += 2;
      acc.set(m.whitePlayerId, bye);
      continue;
    }
    if (!acc.has(m.whitePlayerId)) acc.set(m.whitePlayerId, blank(m.whitePlayerId));
    if (!acc.has(m.blackPlayerId)) acc.set(m.blackPlayerId, blank(m.blackPlayerId));
    const [w, b] = scoreForX2(m.result!);
    const white = acc.get(m.whitePlayerId)!;
    const black = acc.get(m.blackPlayerId)!;
    white.played += 1;
    black.played += 1;
    white.pointsX2 += w;
    black.pointsX2 += b;
    white.opponents.push(m.blackPlayerId);
    black.opponents.push(m.whitePlayerId);
    if (m.result === "white") {
      white.wins += 1;
      black.losses += 1;
      white.beat.add(black.playerId);
    } else if (m.result === "black") {
      black.wins += 1;
      white.losses += 1;
      black.beat.add(white.playerId);
    } else {
      white.draws += 1;
      black.draws += 1;
    }
  }
  return acc;
}

interface Row {
  playerId: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  /** Buchholz, in doubled points. */
  buchholzX2: number;
  /** Exact win-rate key: floor(wins·1000/played), −1 for zero games. */
  winRateKey: number;
  beat: Set<string>;
  eliminatedInRound: number | null | undefined;
}

function buildRows(
  matches: TournamentMatch[],
  playerIds: string[],
  arena: boolean,
): Row[] {
  const acc = accumulate(matches, playerIds);
  const totals = new Map<string, number>();
  for (const [id, a] of acc) totals.set(id, a.pointsX2);

  return [...acc.values()].map((a) => ({
    playerId: a.playerId,
    played: a.played,
    wins: a.wins,
    losses: a.losses,
    draws: a.draws,
    points: a.pointsX2 / 2,
    buchholzX2: a.opponents.reduce((sum, opp) => sum + (totals.get(opp) ?? 0), 0),
    winRateKey: arena
      ? a.played > 0
        ? Math.floor((a.wins * 1000) / a.played)
        : -1
      : 0,
    beat: a.beat,
    eliminatedInRound: undefined as number | null | undefined,
  }));
}

/**
 * The single comparator that defines Swiss/Arena order. Used for both the
 * sort and the shared-rank decision, so the labels can never disagree with
 * the ordering.
 */
function compareRows(a: Row, b: Row): number {
  // 1. Points.
  if (a.points !== b.points) return b.points - a.points;
  // 2. Win rate (arena) — the format-specific key.
  if (a.winRateKey !== b.winRateKey) return b.winRateKey - a.winRateKey;
  // 3. Buchholz.
  if (a.buchholzX2 !== b.buchholzX2) return b.buchholzX2 - a.buchholzX2;
  // 4. Wins (Swiss only; arena already used win rate which subsumes it).
  if (a.wins !== b.wins) return b.wins - a.wins;
  // 5. Head-to-head, only on a single decisive game between exactly these two.
  const aBeatB = a.beat.has(b.playerId);
  const bBeatA = b.beat.has(a.playerId);
  if (aBeatB !== bBeatA) return aBeatB ? -1 : 1;
  // 6. Player id ascending — the deterministic last resort.
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

/**
 * Complete standings for Swiss and Arena. See the module docblock for the
 * exact keys per format. Deterministic: identical inputs → identical output.
 */
export function computeStandings(
  format: TournamentFormat,
  matches: TournamentMatch[],
  entries: TournamentEntry[],
): StandingRow[] {
  const rows = buildRows(matches, entries.map((e) => e.playerId), format === "arena");
  rows.sort(compareRows);
  // Shared rank: a row that compares exactly equal to the row above it gets
  // that row's rank; anything else gets its position. StandingRow.rank is
  // typed number, so the two-pass map below keeps it clean.
  const ranked: StandingRow[] = [];
  let prev: Row | null = null;
  let prevRank = 0;
  rows.forEach((r, i) => {
    const rank = prev && compareRows(prev, r) === 0 ? prevRank : i + 1;
    ranked.push({
      rank,
      playerId: r.playerId,
      played: r.played,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      points: r.points,
      eliminatedInRound: r.eliminatedInRound,
    });
    prev = r;
    prevRank = rank;
  });
  return ranked;
}

/**
 * Knockout standings: finishing position. The final winner is 1, runner-up 2,
 * earlier eliminations fill the ranks below in reverse round order; within a
 * round, the loser the champion beat ranks above the other loser of that
 * round. Players still alive (event running) rank above all eliminated ones.
 */
export function computeKnockoutStandings(
  matches: TournamentMatch[],
  entries: TournamentEntry[],
): StandingRow[] {
  const done = completedMatches(matches);
  const acc = accumulate(matches, entries.map((e) => e.playerId));

  const eliminatedIn = new Map<string, number>();
  let champion: string | null = null;
  const finalRound = done.reduce((max, m) => Math.max(max, m.round), 0);
  for (const m of done) {
    const loser =
      m.result === "white"
        ? m.blackPlayerId
        : m.result === "black"
          ? m.whitePlayerId
          : null; // aborted: no loser recorded here
    if (m.round === finalRound && m.result && finalRound > 0) {
      champion = m.result === "white" ? m.whitePlayerId : m.blackPlayerId;
    }
    if (loser && loser !== SWISS_BYE_OPPONENT) eliminatedIn.set(loser, m.round);
  }

  interface KRow extends StandingRow {
    order: number;
  }
  const rows: KRow[] = [];
  for (const [id, a] of acc) {
    if (champion && id === champion) {
      rows.push({
        rank: 1,
        playerId: id,
        played: a.played,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        points: a.pointsX2 / 2,
        eliminatedInRound: null,
        // Strictly better than every eliminated player: their orders are
        // (finalRound - elim) * 100 ≥ 0, and the runner-up's lost-to-champion
        // bonus is −10, so the champion must sit below 0.
        order: -100,
      });
      continue;
    }
    const elim = eliminatedIn.get(id);
    if (elim === undefined) {
      // Still alive — after every eliminated player, more wins first.
      rows.push({
        rank: 0,
        playerId: id,
        played: a.played,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        points: a.pointsX2 / 2,
        eliminatedInRound: null,
        order: 1_000_000 - a.wins,
      });
      continue;
    }
    const lostToChampion =
      champion !== null &&
      done.some(
        (m) =>
          m.round === elim &&
          ((m.whitePlayerId === id && m.blackPlayerId === champion) ||
            (m.blackPlayerId === id && m.whitePlayerId === champion)),
      );
    rows.push({
      rank: 0,
      playerId: id,
      played: a.played,
      wins: a.wins,
      losses: a.losses,
      draws: a.draws,
      points: a.pointsX2 / 2,
      eliminatedInRound: elim,
      order: (finalRound - elim) * 100 - (lostToChampion ? 10 : 0),
    });
  }

  rows.sort((a, b) => a.order - b.order || a.playerId.localeCompare(b.playerId));
  return rows.map((r, i) => ({
    rank: i + 1,
    playerId: r.playerId,
    played: r.played,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
    points: r.points,
    eliminatedInRound: r.eliminatedInRound,
  }));
}

/** Round labels for the bracket UI. */
export function roundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-final";
  if (fromEnd === 2) return "Quarter-final";
  return `Round ${round}`;
}
