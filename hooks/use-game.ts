"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { describePosition, turnLabel, type PositionInfo } from "@/lib/chess";
import { getStoreForId } from "@/lib/store";
import {
  isGameOver,
  isStaleGameState,
  type GameState,
  type GameStore,
  type PlayerSide,
} from "@/lib/types";

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
   * Optimistic move echo: the position AS IF our move already landed,
   * shown the instant we make it. The server round-trip on a serverless
   * function is 200-600ms — without the echo the piece sat on its original
   * square the whole time, which read as "slow, laggy chess" in tournament
   * games. The echo is superseded by the first server state that moves past
   * the pre-move position, and dropped if the move is rejected.
   */
  const [optimistic, setOptimistic] = useState<{
    fen: string;
    lastMove: { from: string; to: string };
  } | null>(null);

  /** Current game for readers inside callbacks (avoids stale closures). */
  const gameRef = useRef<GameState | null>(null);
  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  /**
   * Every state write goes through here so a late-arriving poll response can
   * never rewind the game. Compared against the *current* state (functional
   * update) rather than a captured one, because a move result and a poll can
   * land in the same tick.
   */
  const applyState = useCallback((next: GameState) => {
    const prev = gameRef.current;
    // Echo resolution: keep the echo while the server hasn't moved past the
    // pre-move position (a lagging 2s poll returns the same FEN); drop it
    // the moment the position moves on (our move confirmed, or anything
    // newer happened).
    setOptimistic((cur) => {
      if (!cur) return null;
      if (next.fen === cur.fen) return null; // adopted
      if (prev && next.fen === prev.fen) return cur; // no progress yet
      return null;
    });
    setGame((p) => (p && isStaleGameState(p, next) ? p : next));
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
    (from: string, to: string, promotion?: string) => {
      // Show the move NOW: validate locally with the same engine the board
      // used, echo the resulting position, and let the server response
      // replace it. A rejected move drops the echo and surfaces the error.
      const g = gameRef.current;
      if (g && g.status === "active") {
        try {
          const probe = new Chess(g.fen);
          const mv = probe.move({ from, to, promotion: promotion ?? "q" });
          if (mv) setOptimistic({ fen: probe.fen(), lastMove: { from: mv.from, to: mv.to } });
        } catch {
          // the server is the authority — let the POST decide
        }
      }
      return runAction("move", () => storeRef.current!.submitMove(id, from, to, promotion)).catch(
        (err) => {
          setOptimistic(null);
          throw err;
        },
      );
    },
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

  /**
   * Check in as present for a tournament match. Fired once per game when the
   * board loads and the game is live but the clock has not started yet — the
   * server stamps the arrival and starts the clock the moment both players
   * are in (or the absence grace expires). Silent: presence is cosmetic on
   * failure, the next poll carries the state either way.
   */
  const arrivedRef = useRef(false);
  useEffect(() => {
    arrivedRef.current = false;
  }, [id]);
  const arrive = useCallback(async () => {
    if (arrivedRef.current) return;
    arrivedRef.current = true;
    try {
      const next = await storeRef.current!.arrive(id);
      applyState(next);
    } catch {
      // best-effort: polling reconciles presence
    }
  }, [id, applyState]);
  const generateSummary = useCallback(
    () => runAction("summary", () => storeRef.current!.generateSummary(id)),
    [id, runAction],
  );

  /* ------------------------------------------------------------------ */
  /* Post-game analysis                                                  */
  /* ------------------------------------------------------------------ */

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
    /** Optimistic position echo (our last move, shown pre-confirmation). */
    optimistic,
    join,
    submitMove,
    submitAiMove,
    resign,
    offerDraw,
    respondDraw,
    abort,
    rematch,
    resolveTimeout,
    arrive,
    generateSummary,
  };
}
