/**
 * Tournament domain types — ChainMate Phase 2A (free tournaments only).
 *
 * Everything here is plain data shared by the server service
 * (lib/server/tournaments.ts), the API routes and the UI. All mutating
 * behaviour lives server-side; the client only reads and displays.
 *
 * Hard boundary: no payment fields beyond the clearly reserved nullable
 * `entryFeeNim` column (never written this phase), no prize pools, no
 * payouts, no wallet logic.
 */

/** The three formats this engine supports. Nothing else exists. */
export type TournamentFormat = "knockout" | "swiss" | "arena";

export const TOURNAMENT_FORMATS: TournamentFormat[] = ["knockout", "swiss", "arena"];

export function isTournamentFormat(v: unknown): v is TournamentFormat {
  return typeof v === "string" && (TOURNAMENT_FORMATS as string[]).includes(v);
}

/**
 * The lifecycle every tournament walks. DRAFT exists so a host can prepare
 * (description, player limit) before opening registration; REGISTRATION is
 * the join/leave window; LOCKED freezes the field while the host (or the
 * engine) gets ready to run; IN_PROGRESS has live games; COMPLETED and
 * CANCELLED are terminal.
 *
 * Legal transitions, enforced server-side in lib/server/tournaments.ts:
 *   DRAFT → REGISTRATION | CANCELLED
 *   REGISTRATION → LOCKED | CANCELLED
 *   LOCKED → IN_PROGRESS | REGISTRATION (reopen) | CANCELLED
 *   IN_PROGRESS → COMPLETED | CANCELLED
 */
export type TournamentStatus =
  | "draft"
  | "registration"
  | "locked"
  | "in_progress"
  | "completed"
  | "cancelled";

export const TOURNAMENT_TERMINAL_STATUSES: TournamentStatus[] = ["completed", "cancelled"];

export function isTournamentTerminal(status: TournamentStatus): boolean {
  return TOURNAMENT_TERMINAL_STATUSES.includes(status);
}

/**
 * One registered player. Entries are the join records (1 per player per event).
 *
 * Phase 2B: a PAID tournament entry carries `paid` — set by the server only,
 * after the entry fee's on-chain transaction has been verified through the
 * Phase 1C engine. The client never sets it.
 */
export interface TournamentEntry {
  playerId: string;
  /** Unix ms the player registered (registration order seeds knockout slots). */
  joinedAt: number;
  /** Unix ms the player left, when they left during registration. */
  leftAt?: number;
  /**
   * Unix ms the player withdrew AFTER the tournament started. A withdrawn
   * player keeps every completed result and their standing row (the record
   * is never rewritten), but receives no future pairings. Entry fees stay
   * locked once the event is running.
   */
  withdrawnAt?: number;
  /** Proof of payment for paid tournaments: the verified tx + verify time. */
  paid?: { txHash: string; paidAt: number };
}

/**
 * One scheduled game inside a tournament. Always references an existing
 * hosted ChainMate game — the tournament engine owns no board logic of its
 * own, it only reacts to the game's authoritative result.
 */
export interface TournamentMatch {
  id: string;
  tournamentId: string;
  /** Tournaments are single-segment in 2A; reserved for future stages. */
  round: number;
  /** Which pairing slot within the round (bracket position for knockout). */
  slot: number;
  whitePlayerId: string;
  blackPlayerId: string;
  /** The authoritative ChainMate game this match plays on. */
  gameId: string;
  /** "pending" until the referenced game reaches a terminal, played state. */
  status: "pending" | "active" | "complete";
  /** Absolute result, mirrored from the game when it ends. Written by the server only. */
  result?: "white" | "black" | "draw";
  /** How the game actually ended — straight from GameStatus, for UI display. */
  resultReason?: string;
  /** Unix ms the match was created. */
  createdAt: number;
  /** Unix ms the result was recorded. */
  completedAt?: number;
  /**
   * Knockout only: game ids of DECISIVE-GAME replays played after drawn
   * games (the tiebreak policy). The current game lives in `gameId`; earlier
   * drawn games are archived here so the record is auditable.
   */
  tiebreakGameIds?: string[];
}

/** A Swiss/Knockout round as the UI sees it. */
export interface TournamentRound {
  index: number;
  /** Human label ("Round 1", "Quarter-final"…). */
  label: string;
  matches: TournamentMatch[];
  /** True while any match in the round is still pending/active. */
  open: boolean;
}

/** Sentinel opponent id used only for Swiss byes (odd field, no opponent). */
export const SWISS_BYE_OPPONENT = "__bye__";

/**
 * One player's line in the standings table. Deterministic: two players with
 * identical tiebreak tuples always get the same rank (shared), so a recompute
 * from the same game data can never shuffle the table.
 */
export interface StandingRow {
  rank: number;
  playerId: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  /** Scoring per format — see scoring rules in lib/tournament-standings.ts. */
  points: number;
  /** Knockout only: how far the player got (1 = won the final). */
  eliminatedInRound?: number | null;
}

/* ------------------------------------------------------------------ */
/* Format configuration                                                */
/* ------------------------------------------------------------------ */

export interface TournamentSettings {
  knockout: { rounds: number };
  swiss: { rounds: number };
  arena: { maxGamesPerPairing: number };
}

/** Deterministic round counts. Knockout: ceil(log2(n)) is computed at start. */
export function knockoutRoundCount(playerCount: number): number {
  if (playerCount < 2) return 0;
  return Math.ceil(Math.log2(playerCount));
}

/** Swiss default: 5 rounds, capped so a small field doesn't over-pair. */
export const SWISS_DEFAULT_ROUNDS = 5;
export const SWISS_MAX_ROUNDS = 11;

/** Arena: a fresh pairing is only made when the player has no active game. */
export const ARENA_MAX_ACTIVE_PER_PLAYER = 1;

/* ------------------------------------------------------------------ */
/* Public API payloads                                                 */
/* ------------------------------------------------------------------ */

/** Prize distribution presets for PAID tournaments (Phase 2B). */
export type TournamentPrizePreset = "winner" | "top3" | "top5";

/** What the list endpoint serves (no standings — details carry those). */
export interface TournamentSummary {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  creatorName?: string;
  format: TournamentFormat;
  timeControl: string;
  /** Configured cap. Registration closes automatically when reached. */
  maxPlayers: number;
  status: TournamentStatus;
  /** Number of non-withdrawn entries (denormalised for the list view). */
  playerCount: number;
  registrationClosesAt: number | null;
  /** Scheduled start (Unix ms) — countdown shown while it is in the future. */
  scheduledStartAt?: number | null;
  /** Arena: when the tournament window closes (Unix ms); auto-finalizes. */
  scheduledEndAt?: number | null;
  startedAt: number | null;
  completedAt: number | null;
  /**
   * Intermission countdown: the instant the next round will be dealt (Swiss
   * / knockout). Set the moment a round's last game ends; null when none is
   * pending. The UI shows a round-ended banner with this countdown.
   */
  nextRoundAt?: number | null;
  /** Server's intermission length, so the UI copy never disagrees with it. */
  roundIntermissionMs?: number;
  createdAt: number;
  /** Formats that run rounds expose this while in progress. */
  currentRound?: number;
  totalRounds?: number;
  /** Winner's player id, set by the server when the event completes. */
  winnerId?: string | null;
  /** Phase 2B economy: exact entry fee in luna (null/"0" = free tournament). */
  entryFeeLuna?: string | null;
  /** Phase 2B economy: prize distribution preset for paid tournaments. */
  prizePreset?: TournamentPrizePreset | null;
  /** Phase 2B economy: aggregate payout state ("none" until completion). */
  payoutStatus?: "none" | "pending" | "partial" | "paid" | "refund_required" | "refunded";
  /**
   * Live verified prize pool in luna (paid tournaments only; the exact sum
   * of verified entry payments, recomputed server-side on every read).
   * Detail payloads carry the true ledger sum — NOT the sum of payout rows,
   * which under-reports when the field is shorter than the preset's ranks.
   */
  verifiedPoolLuna?: string | null;
  /** Server-stored cancellation reason ("Not enough players…", host note…). */
  cancelReason?: string | null;
  /** Minimum players this event needed (set from the preset at creation). */
  minPlayers?: number | null;
  /**
   * Host's creation-time choice: lock + start the moment the field reaches
   * maxPlayers (instead of waiting for the scheduled start or the host).
   */
  startWhenFull?: boolean;
}

/**
 * UI-safe refund line for the tournament detail page: one owed or returned
 * entry fee from a cancelled paid event (or a player who left before lock).
 */
export interface TournamentRefundLine {
  playerId: string;
  amountLuna: string;
  status: "owed" | "dispatched" | "verified" | "failed";
}

/** Full tournament detail payload served by GET /api/tournaments/[id]. */
export interface TournamentDetail extends TournamentSummary {
  entries: TournamentEntry[];
  rounds: TournamentRound[];
  /** Refund obligations for paid events (cancel / leave-before-lock). */
  refunds?: TournamentRefundLine[];
  standings: StandingRow[];
  /** "host" | "entrant" | "none" from the requesting player's perspective. */
  myRole: "host" | "entrant" | "none";
  /** Whether I currently have an unfinished game in this event to resume. */
  myActiveGameId?: string | null;
}

/** Public payout line for the UI (no destination address, no treasury internals). */
export interface TournamentPayoutLine {
  playerId: string;
  payoutRank: number;
  shareBps: number;
  amountLuna: string;
  status:
    | "pending"
    | "dispatching"
    | "sent"
    | "verified"
    | "failed"
    | "blocked_no_wallet";
}

/** Validation error strings the create endpoint can return. */
export type TournamentCreateError =
  | "name required (2–60 chars)"
  | "description too long (max 500 chars)"
  | "format must be knockout, swiss or arena"
  | "timeControl must look like '10 + 0'"
  | "maxPlayers must be an integer 2–128"
  | "swiss rounds must be an integer 1–11"
  | "registration window invalid"
  | "scheduled start must be in the future"
  | "registration must close before the scheduled start";
