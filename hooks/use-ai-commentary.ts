"use client";

import { useEffect, useState } from "react";
import { AI_ENABLED } from "@/lib/config";
import type { GameState } from "@/lib/types";

/**
 * LLM commentary for the latest move. Only active when
 * NEXT_PUBLIC_AI_ENABLED=true AND the server has AI_API_KEY set.
 */
export function useAiCommentary(game: GameState | null) {
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastMove = game?.moves.length ? game.moves[game.moves.length - 1] : null;
  const moveNumber = lastMove?.number ?? 0;

  useEffect(() => {
    setInsight(null);
    setError(null);
    if (!game || !lastMove || !AI_ENABLED) return;

    let cancelled = false;
    setLoading(true);
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
          setError("AI commentary unavailable");
          return;
        }
        const data = (await res.json()) as { text?: string };
        setInsight(data.text ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("AI commentary unavailable");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [game?.id, moveNumber, game?.fen, lastMove?.san, lastMove?.side, game]);

  return { insight, loading, error, enabled: AI_ENABLED };
}
