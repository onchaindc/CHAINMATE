"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describePosition, turnLabel, type PositionInfo } from "@/lib/chess";
import { getStoreForId } from "@/lib/store";
import type { GameState, GameStore, PlayerSide } from "@/lib/types";

export type BusyAction = "join" | "move" | "resign" | "summary" | null;

export function useGame(id: string) {
  const storeRef = useRef<GameStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = getStoreForId(id);
  }

  const [game, setGame] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);

  useEffect(() => {
    const store = storeRef.current!;
    let cancelled = false;

    setLoading(true);
    setError(null);
    store
      .getGame(id)
      .then((state) => {
        if (cancelled) return;
        setGame(state);
        setLoading(false);
        if (!state) setError("Game not found");
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "Failed to load game");
      });

    const unsubscribe = store.subscribe(id, (state) => {
      setGame(state);
      setError(null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id]);

  const runAction = useCallback(
    async (label: Exclude<BusyAction, null>, fn: () => Promise<GameState>) => {
      setBusy(label);
      setError(null);
      try {
        const next = await fn();
        setGame(next);
        return next;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);
        throw err;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const join = useCallback(
    () => runAction("join", () => storeRef.current!.joinGame(id)),
    [id, runAction],
  );
  const submitMove = useCallback(
    (from: string, to: string, promotion?: string) =>
      runAction("move", () => storeRef.current!.submitMove(id, from, to, promotion)),
    [id, runAction],
  );
  const submitAiMove = useCallback(
    () => runAction("move", () => storeRef.current!.submitAiMove(id)),
    [id, runAction],
  );
  const resign = useCallback(
    () => runAction("resign", () => storeRef.current!.resign(id)),
    [id, runAction],
  );
  const generateSummary = useCallback(
    () => runAction("summary", () => storeRef.current!.generateSummary(id)),
    [id, runAction],
  );

  const pos: PositionInfo | null = useMemo(
    () => (game ? describePosition(game.fen) : null),
    [game?.fen, game],
  );

  const myId = useMemo(() => storeRef.current!.getMyPlayerId(), []);

  const mySide: PlayerSide | null = useMemo(() => {
    if (!game) return null;
    if (game.creator === myId) return "white";
    if (game.opponent === myId) return "black";
    return null;
  }, [game?.creator, game?.opponent, myId]);

  const turnSide: PlayerSide | null = pos ? turnLabel(pos.turn) : null;
  const myTurn = mySide !== null && turnSide === mySide;

  const winnerSide: PlayerSide | null = useMemo(() => {
    if (!game || !game.winner) return null;
    if (game.winner === game.creator) return "white";
    if (game.winner === game.opponent) return "black";
    return null;
  }, [game?.winner, game?.creator, game?.opponent]);

  return {
    game,
    loading,
    error,
    busy,
    pos,
    myId,
    mySide,
    turnSide,
    myTurn,
    winnerSide,
    join,
    submitMove,
    submitAiMove,
    resign,
    generateSummary,
  };
}
