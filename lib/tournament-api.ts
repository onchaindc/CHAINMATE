"use client";

import { getIdentityToken } from "@/lib/identity";
import type {
  StandingRow,
  TournamentEntry,
  TournamentFormat,
  TournamentPayoutLine,
  TournamentRound,
  TournamentStatus,
  TournamentSummary,
} from "@/lib/tournament-types";

/**
 * Client access to the tournament API. Read-only display plus the six
 * mutations the server exposes; there is deliberately no way to send a
 * result, winner or rank — the engine computes those from the games.
 */

interface ApiError {
  error?: string;
  /** Server-defined failure category (e.g. "verification-failed"). */
  kind?: string;
}

/**
 * Error thrown for every non-OK tournament API response. Carries the server's
 * typed failure `kind` so callers can distinguish a retryable condition
 * (verification still pending) from a terminal one (wrong sender, replay).
 */
export class TournamentApiError extends Error {
  readonly kind: string | null;
  readonly status: number;
  constructor(message: string, opts: { kind?: string | null; status?: number } = {}) {
    super(message);
    this.name = "TournamentApiError";
    this.kind = opts.kind ?? null;
    this.status = opts.status ?? 0;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getIdentityToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok || data.error) {
    throw new TournamentApiError(data.error ?? `Request failed (${res.status})`, {
      kind: data.kind ?? null,
      status: res.status,
    });
  }
  return data;
}

export interface TournamentDetailPayload {
  summary: TournamentSummary;
  entries: TournamentEntry[];
  rounds: TournamentRound[];
  standings: StandingRow[];
  myRole: "host" | "entrant" | "none";
  myActiveGameId: string | null;
  /** Display names the server resolved for participants + the host. */
  entryNames?: Record<string, string>;
  /** Phase 2B: payout lines for completed paid tournaments. */
  payouts?: TournamentPayoutLine[];
  /** Refund obligations for paid events (cancel / leave before lock). */
  refunds?: Array<{
    playerId: string;
    amountLuna: string;
    status: "owed" | "dispatched" | "verified" | "failed";
  }>;
}

export type TournamentAction =
  | "join"
  | "leave"
  | "open-registration"
  | "lock"
  | "reopen-registration"
  | "start"
  | "complete"
  | "cancel"
  | "delete"
  | "pair";

export interface CreateTournamentPayload {
  name: string;
  description?: string;
  format: TournamentFormat;
  timeControl: string;
  maxPlayers: number;
  swissRounds?: number;
  /** Scheduled start (Unix ms) — registration opens automatically then. */
  scheduledStartAt?: number | null;
  /** Phase 2B: human NIM string ("5", "1.25"). Omit for a free tournament. */
  entryFeeNim?: string;
  /** Phase 2B: required when entryFeeNim is set. */
  prizePreset?: "winner" | "top3" | "top5";
}

export const tournamentApi = {
  async list(status?: TournamentStatus): Promise<{
    tournaments: TournamentSummary[];
    players: Record<string, string>;
  }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return call(`/api/tournaments${qs}`);
  },

  async detail(id: string, playerId?: string): Promise<TournamentDetailPayload> {
    const qs = playerId ? `?playerId=${encodeURIComponent(playerId)}` : "";
    return call(`/api/tournaments/${encodeURIComponent(id)}${qs}`);
  },

  async action(id: string, playerId: string, action: TournamentAction): Promise<void> {
    await call(`/api/tournaments/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ playerId, action }),
    });
  },

  async create(payload: CreateTournamentPayload, playerId: string): Promise<{ id: string }> {
    const data = await call<{ tournament?: { id: string } }>("/api/tournaments", {
      method: "POST",
      body: JSON.stringify({ ...payload, playerId }),
    });
    if (!data.tournament?.id) throw new Error("Failed to create tournament");
    return { id: data.tournament.id };
  },

  /**
   * Phase 2B: submit a tx hash to pay for a paid tournament entry. The
   * server verifies the real on-chain transaction and returns the typed
   * outcome; insufficient confirmations arrive as a thrown error whose
   * message the UI surfaces as retryable.
   */
  async submitEntryTx(
    tournamentId: string,
    playerId: string,
    txHash: string,
  ): Promise<{ txHash: string; amountLuna: string; network: string }> {
    const data = await call<{
      ok: true;
      entry: { txHash: string; amountLuna: string; network: string };
    }>(`/api/tournaments/${encodeURIComponent(tournamentId)}/entry`, {
      method: "POST",
      body: JSON.stringify({ playerId, txHash }),
    });
    return data.entry;
  },

  /** Phase 2B: public payout lines for a tournament. */
  async payouts(tournamentId: string): Promise<TournamentPayoutLine[]> {
    const data = await call<{ payouts: TournamentPayoutLine[] }>(
      `/api/tournaments/${encodeURIComponent(tournamentId)}/payouts`,
    );
    return data.payouts;
  },

  /** Phase 2B/3B: host-only payout action (plan | send | retry | dispatch | verify). */
  async payoutAction(
    tournamentId: string,
    playerId: string,
    action: "plan" | "send" | "retry" | "dispatch" | "verify" | "wallet-prepare" | "wallet-claim" | "wallet-confirm",
    targetPlayerId?: string,
    txHash?: string,
  ): Promise<Record<string, unknown>> {
    return call(`/api/tournaments/${encodeURIComponent(tournamentId)}/payouts`, {
      method: "POST",
      body: JSON.stringify({ playerId, action, targetPlayerId, txHash }),
    });
  },
};
