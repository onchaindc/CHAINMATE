"use client";

import { useEffect, useRef } from "react";
import { AI_PLAYER_ID, type GameState } from "@/lib/types";

interface UseAiOpponentOptions {
  game: GameState | null;
  submitAiMove: () => Promise<GameState>;
  /** Skip scheduling while the UI is busy (e.g. a move is in flight). */
  disabled?: boolean;
}

/**
 * Drives the single-player AI: whenever it's the AI's turn (game active and
 * the AI side to move), wait a moment so the human's move visibly lands, then
 * ask the store to play the AI's reply.
 *
 * Scheduling is keyed by FEN so duplicate subscription events (BroadcastChannel,
 * storage events, polling) can never fire two AI moves. The pending timer is
 * only cleared on unmount; stale fires are harmless because the store no-ops
 * when the position no longer belongs to the AI.
 */
export function useAiOpponent({ game, submitAiMove, disabled }: UseAiOpponentOptions) {
  const lastScheduledFen = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (disabled || !game) return;
    if (game.status !== "active" || game.opponent !== AI_PLAYER_ID) {
      lastScheduledFen.current = "";
      return;
    }

    const aiSide = game.creator === AI_PLAYER_ID ? "w" : "b";
    const turn = game.fen.split(" ")[1] ?? "w";
    if (turn !== aiSide) {
      lastScheduledFen.current = "";
      return;
    }

    if (lastScheduledFen.current === game.fen) return;
    lastScheduledFen.current = game.fen;

    timerRef.current = setTimeout(() => {
      void submitAiMove().catch(() => {
        // Store errors mean the position changed under us — re-arm so a
        // later effect run can schedule again if it's still the AI's turn.
        lastScheduledFen.current = "";
      });
    }, 650);
  }, [game, submitAiMove, disabled]);
}
