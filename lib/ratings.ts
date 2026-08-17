/**
 * ChainMate rating engine — Glicko-1 with rating-deviation (RD) decay.
 *
 * Why Glicko instead of plain Elo: every player carries a rating AND a
 * confidence value (RD). A new or inactive player has a high RD, so a single
 * result moves their rating more; an established player with a low RD barely
 * moves after a game. This is the Chess.com-style behaviour the product
 * wants: no hardcoded +8/-8, changes depend on the opponent's rating and
 * both players' confidence.
 *
 * The rating `r` stays on the familiar 1200-centred scale, so all displays
 * (profile, leaderboard, result screen) keep working unchanged.
 */

export interface RatingState {
  /** Current rating (Glicko r, same scale as the old Elo). */
  rating: number;
  /** Rating deviation — how confident the rating is (30 = solid, 350 = new). */
  rd: number;
  /** Unix ms of the player's last rated game (drives RD decay). */
  lastPlayedAt: number | null;
}

export const START_RATING = 1200;
export const START_RD = 350;
export const MIN_RD = 30;
export const MAX_RD = 350;
export const RATING_FLOOR = 100;

/** Glicko-1 constant q. */
const Q = Math.LN10 / 400;
/** RD growth per rating period (a day) of inactivity — Glicko-2 style c. */
const DECAY_C = 63;
const DECAY_PERIOD_MS = 24 * 60 * 60 * 1000;

function g(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

function expectedScore(r: number, oppR: number, oppRd: number): number {
  return 1 / (1 + Math.pow(10, (-g(oppRd) * (r - oppR)) / 400));
}

/** RD grows back toward MAX_RD while a player is inactive. */
export function decayRd(rating: RatingState, now: number): RatingState {
  if (!rating.lastPlayedAt) return rating;
  const periods = Math.floor(Math.max(0, now - rating.lastPlayedAt) / DECAY_PERIOD_MS);
  if (periods <= 0) return rating;
  return {
    ...rating,
    rd: Math.min(MAX_RD, Math.sqrt(rating.rd * rating.rd + DECAY_C * DECAY_C * periods)),
  };
}

export interface GlickoResult {
  a: RatingState;
  b: RatingState;
}

/**
 * Glicko-1 update for one game between two players. Both sides update
 * atomically from each other's pre-game (decayed) state. `scoreA` is A's
 * result: 1 = win, 0.5 = draw, 0 = loss. Returns new RatingStates with
 * `lastPlayedAt` set to `now`.
 */
export function glickoUpdate(
  a: RatingState,
  b: RatingState,
  scoreA: number,
  now: number = Date.now(),
): GlickoResult {
  const A = decayRd(a, now);
  const B = decayRd(b, now);

  const expectedA = expectedScore(A.rating, B.rating, B.rd);
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;

  // Variance of the rating estimate (d²) for each side.
  const d2A = 1 / (Q * Q * g(B.rd) * g(B.rd) * expectedA * (1 - expectedA));
  const d2B = 1 / (Q * Q * g(A.rd) * g(A.rd) * expectedB * (1 - expectedB));

  const ratingA = Math.max(
    RATING_FLOOR,
    Math.round(A.rating + (Q / (1 / (A.rd * A.rd) + 1 / d2A)) * g(B.rd) * (scoreA - expectedA)),
  );
  const ratingB = Math.max(
    RATING_FLOOR,
    Math.round(B.rating + (Q / (1 / (B.rd * B.rd) + 1 / d2B)) * g(A.rd) * (scoreB - expectedB)),
  );

  const rdA = Math.round(Math.sqrt(1 / (1 / (A.rd * A.rd) + 1 / d2A)));
  const rdB = Math.round(Math.sqrt(1 / (1 / (B.rd * B.rd) + 1 / d2B)));

  return {
    a: { rating: ratingA, rd: clampRd(rdA), lastPlayedAt: now },
    b: { rating: ratingB, rd: clampRd(rdB), lastPlayedAt: now },
  };
}

function clampRd(rd: number): number {
  return Math.max(MIN_RD, Math.min(MAX_RD, rd));
}
