"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describePosition, turnLabel, type PositionInfo } from "@/lib/chess";
import { getStoreForId } from "@/lib/store";
import { isStaleGameState, type GameState, type GameStore, type PlayerSide } from "@/lib/types";

export type BusyAction =
  | "join"
  | "move"
  | "resign"
  | "draw-offer"
  | "draw-respond"
  | "abort"
  | "rematch"
  | "summary"
  | null;

export function useGame(id: string) {
  const storeRef = useRef<GameStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = getStoreForId(id);
  }

  const [game, setGame] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);

  /**
   * Every state write goes through here so a late-arriving poll response can
   * never rewind the game. Compared against the *current* state (functional
   * update) rather than a captured one, because a move result and a poll can
   * land in the same tick.
   */
  const applyState = useCallback((next: GameState) => {
    setGame((prev) => (prev && isStaleGameState(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    const store = storeRef.current!;
    let cancelled = false;

    setLoading(true);
    setError(null);
    // Drop the previous game's state so a rematch (new id, same page) can't
    // render the finished game — and its result modal — under the new URL.
    setGame(null);
    store
      .getGame(id)
      .then((state) => {
        if (cancelled) return;
        if (state) applyState(state);
        setLoading(false);
        if (!state) setError("Game not found");
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : "Failed to load game");
      });

    const unsubscribe = store.subscribe(id, (state) => {
      applyState(state);
      setError(null);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id, applyState]);

  const runAction = useCallback(
    async (
      label: Exclude<BusyAction, null>,
      fn: () => Promise<GameState>,
      /** Rematch creates a *different* game, so its result isn't ours to show. */
      apply = true,
    ) => {
      setBusy(label);
      setError(null);
      try {
        const next = await fn();
        if (apply) applyState(next);
        return next;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong";
        setError(message);
        throw err;
      } finally {
        setBusy(null);
      }
    },
    [applyState],
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
  const offerDraw = useCallback(
    () => runAction("draw-offer", () => storeRef.current!.offerDraw(id)),
    [id, runAction],
  );
  const respondDraw = useCallback(
    (accept: boolean) =>
      runAction("draw-respond", () => storeRef.current!.respondDraw(id, accept)),
    [id, runAction],
  );
  const abort = useCallback(
    () => runAction("abort", () => storeRef.current!.abort(id)),
    [id, runAction],
  );
  const rematch = useCallback(
    // `apply: false` — the server creates a brand-new game, and writing that
    // into this hook (still bound to the old id) would flash the fresh board
    // and re-fire the end-game modal before the caller navigates.
    () => runAction("rematch", () => storeRef.current!.rematch(id), false),
    [id, runAction],
  );
  /** Settle a flag fall right now — silent: failures fall back to polling. */
  const resolveTimeout = useCallback(async () => {
    try {
      const next = await storeRef.current!.resolveTimeout(id);
      applyState(next);
      return next;
    } catch {
      // the next poll will settle it server-side
      return null;
    }
  }, [id, applyState]);
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
    offerDraw,
    respondDraw,
    abort,
    rematch,
    resolveTimeout,
    generateSummary,
  };
}
