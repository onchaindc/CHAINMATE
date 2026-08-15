"use client";

import { useCallback, useEffect, useState } from "react";
import { AI_ENABLED } from "@/lib/config";
import type { GameState } from "@/lib/types";

export type AnalysisStatus = "analyzing" | "ready" | "unavailable" | "failed";

/**
 * LLM commentary for the latest move. Only active when
 * NEXT_PUBLIC_AI_ENABLED=true AND the server has AI_API_KEY set; otherwise the
 * analysis panel falls back to the rule-based engine entries stored on the
 * game. Never blocks the game — failure surfaces as "failed" + retry.
 */
export function useAiCommentary(game: GameState | null) {
  const [insight, setInsight] = useState<string | null>(null);
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [attempt, setAttempt] = useState(0);

  const lastMove = game?.moves.length ? game.moves[game.moves.length - 1] : null;
  const moveNumber = lastMove?.number ?? 0;

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    setInsight(null);
    if (!game || !lastMove || !AI_ENABLED) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    setStatus("analyzing");
    fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "commentary",
        fen: game.fen,
        lastMoveSan: lastMove.san,
        side: lastMove.side === "white" ? "White" : "Black",
      }),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus("failed");
          return;
        }
        const data = (await res.json()) as { text?: string };
        if (data.text) {
          setInsight(data.text);
          setStatus("ready");
        } else {
          setStatus("unavailable");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [game?.id, moveNumber, game?.fen, lastMove?.san, lastMove?.side, game, attempt]);

  return { insight, status, retry, enabled: AI_ENABLED };
}
