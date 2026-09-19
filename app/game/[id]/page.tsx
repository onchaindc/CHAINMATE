"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Ban,
  Bot,
  ChevronLeft,
  ChevronRight,
  Flag,
  Handshake,
  Loader2,
  RefreshCw,
  SkipBack,
  SkipForward,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BoardSettings } from "@/components/game/board-settings";
import { CaptureTray } from "@/components/game/capture-tray";
import { ChessBoard } from "@/components/game/chess-board";
import { EndGameModal } from "@/components/game/end-game-modal";
import { GameChat } from "@/components/game/game-chat";
import { MoveHistory } from "@/components/game/move-history";
import { PlayerCard } from "@/components/game/player-card";
import { StatusBar } from "@/components/game/status-bar";
import { WaitingPanel } from "@/components/game/waiting-panel";
import { useAiOpponent } from "@/hooks/use-ai-opponent";
import { useBoardPrefs } from "@/hooks/use-board-prefs";
import { useClocks } from "@/hooks/use-clocks";
import { useGame } from "@/hooks/use-game";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { fenAfterPly } from "@/lib/chess";
import { isHostedGameId, isLocalGameId } from "@/lib/config";
import { describeResult } from "@/lib/game-result";
import { AI_PLAYER_ID, aiLevelFor, isGameOver, type PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function GamePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const identity = useIdentity();
  const router = useRouter();

  const {
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
    arrive,
    generateSummary,
  } = useGame(id);

  const isAiGame = game?.opponent === AI_PLAYER_ID;
  useAiOpponent({ game, submitAiMove, disabled: busy !== null });

  const gameOver = game ? isGameOver(game.status) : false;

  /* ------------------------------------------------------------------ */
  /* Board-time travel. `ply` is how many moves of the recorded game the
     board shows; null means "live". After the game ends it becomes a full
     replay (?replay=1 links land the same way). WHILE THE GAME IS LIVE it
     powers the step-back control: a player who missed the opponent's move
     rewinds the board to see it, then follows the moves forward to catch
     up. Any new move snaps the board back to live, and making your own
     move while stepped back is blocked (the input targets the live
     position, not the one on screen). */
  /* ------------------------------------------------------------------ */
  const [ply, setPly] = useState<number | null>(null);
  const replayMode = gameOver && ply !== null;
  /** Stepped back during a live game — board shows history, moves disabled. */
  const reviewing = !gameOver && ply !== null && game !== null && ply < game.moves.length;

  useEffect(() => {
    if (game && gameOver && ply === null) {
      setPly(game.moves.length);
    }
  }, [game, gameOver, ply]);

  // A new move arriving while reviewing snaps the board back to live —
  // the player has seen what they needed; play continues on the real position.
  useEffect(() => {
    if (!game || gameOver || ply === null) return;
    if (ply > game.moves.length) setPly(game.moves.length);
    else if (ply === game.moves.length) setPly(null);
  }, [game?.moves.length, gameOver]); // eslint-disable-line react-hooks/exhaustive-deps -- ply intentionally read once per move-count change

  // Keyboard navigation while replaying or reviewing (←/→/Home/End).
  useEffect(() => {
    if ((!replayMode && !reviewing) || !game) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, (p ?? game.moves.length) - 1));
      else if (e.key === "ArrowRight")
        setPly((p) => {
          const next = Math.min(game.moves.length, (p ?? 0) + 1);
          return next >= game.moves.length && !gameOver ? null : next; // forward past live = live
        });
      else if (e.key === "Home") setPly(0);
      else if (e.key === "End") setPly(gameOver ? game.moves.length : null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replayMode, reviewing, game, gameOver]);

  const boardRef = useRef<HTMLDivElement>(null);
  const startReplay = useCallback(() => {
    setPly(0);
    boardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /* ------------------------------------------------------------------ */
  /* Mobile: keep the viewport steady while the board updates. Some     */
  /* mobile browsers scroll the page when the board re-renders after a  */
  /* move (layout/animation churn around the re-render). We capture the */
  /* scroll position the moment the player makes their move and restore */
  /* it the instant the new position lands — so the board never jumps   */
  /* away mid-game on touch devices. Desktop is unaffected.             */
  /* ------------------------------------------------------------------ */
  const touchDeviceRef = useRef(false);
  const pendingScrollRef = useRef<number | null>(null);
  useEffect(() => {
    touchDeviceRef.current = window.matchMedia("(pointer: coarse)").matches;
  }, []);

  const previousFenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!game) return;
    const fen = game.fen;
    if (previousFenRef.current !== null && previousFenRef.current !== fen) {
      // The position just changed (own move or opponent reply) — put the
      // viewport back where the player left it before the move round-trip.
      if (pendingScrollRef.current !== null) {
        window.scrollTo({ top: pendingScrollRef.current, behavior: "instant" });
        pendingScrollRef.current = null;
      }
    }
    previousFenRef.current = fen;
  }, [game?.fen]);

  /* ------------------------------------------------------------------ */
  /* Post-game modal: appears once, ~1.5s AFTER the final move so the     */
  /* player actually sees the checkmate land before the popup covers it.  */
  /* ------------------------------------------------------------------ */
  const [resultOpen, setResultOpen] = useState(false);
  /**
   * Which result this page has already announced ("<game id>:<status>").
   * Without it the modal re-opened on every render where `gameOver` had just
   * become true again, so a player who dismissed it got it back seconds later
   * — and a late poll landing an older snapshot made it flicker between
   * results. The result banner below stays put regardless, so closing the
   * modal never loses the information. Once dismissed it stays dismissed:
   * the timer only ever fires once per result.
   */
  const announcedResult = useRef<string | null>(null);
  /**
   * True once this page load has seen the game in a NON-terminal state. A
   * player opening a link straight into a finished game (match report,
   * notification, refresh after the fact) already saw the popup when the
   * game actually ended — reopening it on load was the "stubborn popup"
   * complaint. The banner above the board still tells the result; the
   * ceremony belongs to the moment the game ends, not to every visit.
   */
  const sawLiveGame = useRef(false);
  const modalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!game) return;
    if (!gameOver) {
      sawLiveGame.current = true;
      return;
    }
    // Aborted games are non-events: no result, no rating change, nothing to
    // report. The quiet banner below is the whole ceremony they get.
    if (game.status === "aborted") return;
    // A page load landing directly on a finished game never auto-opens.
    if (!sawLiveGame.current) return;
    const key = `${game.id}:${game.status}`;
    if (announcedResult.current === key) return;
    announcedResult.current = key;
    // Let the final position breathe: the mating move is on the board and
    // the banner is up before the celebration covers it.
    modalTimer.current = setTimeout(() => setResultOpen(true), 1500);
    return () => {
      if (modalTimer.current) clearTimeout(modalTimer.current);
    };
  }, [game?.id, game?.status, gameOver]); // eslint-disable-line react-hooks/exhaustive-deps -- key narrows the trigger

  /* Board control: flip the board (useful for spectators and for reviewing
     the game from the opponent's point of view). Local view state only. */
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    setFlipped(false);
  }, [id]);

  /* Board colours and piece artwork, remembered across sessions per player. */
  const { boardTheme, pieceSet, setBoardTheme, setPieceSet } = useBoardPrefs();

  /* The board shows the position at `ply` while REVIEWING a live game too —
     that is the whole point of the Back button: a player who missed the
     opponent's move rewinds to see it. Only replay mode (finished game) and
     live review share this one derivation, so the rewind can never be a
     no-op. */
  const boardFen = useMemo(() => {
    if (game && ply !== null && ply < game.moves.length) return fenAfterPly(game.moves, ply);
    return game?.fen ?? null;
  }, [game, ply]);

  /* The last-move highlight follows the position on screen, live or rewound. */
  const shownLastMove = useMemo(() => {
    if (!game || ply === null || ply === 0 || ply > game.moves.length) {
      const last = game?.moves[game.moves.length - 1];
      return last ? { from: last.from, to: last.to } : null;
    }
    const m = game.moves[ply - 1];
    return m ? { from: m.from, to: m.to } : null;
  }, [game, ply]);

  /* ------------------------------------------------------------------ */
  /* Real player data: ratings for both sides + this game's deltas.      */
  /* ------------------------------------------------------------------ */
  const [profiles, setProfiles] = useState<Record<string, PlayerStats>>({});

  useEffect(() => {
    if (!game) return;
    // Fetch real ratings for both humans — hosted games, solo games against
    // the computer, and local two-player games alike. The server is the
    // authority: guests get provisional 1200, accounts get their persisted
    // rating (never a hardcoded default).
    const ids = [game.creator, game.opponent].filter((p) => p && p !== AI_PLAYER_ID);
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, PlayerStats> = {};
      await Promise.all(
        ids.map(async (playerId) => {
          try {
            const res = await fetch(`/api/hosted/players/me?playerId=${encodeURIComponent(playerId)}`);
            const data = (await res.json()) as { stats?: PlayerStats };
            if (data.stats) next[playerId] = data.stats;
          } catch {
            // profile data is optional — the game itself never depends on it
          }
        }),
      );
      if (!cancelled) setProfiles(next);
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch the moment a game ends so the result modal shows the real
    // rating deltas the server just applied (+X / −X), not the pre-game
    // ratings. Same players — status/endedAt is what changed.
  }, [game?.id, game?.creator, game?.opponent, game?.status, game?.endedAt]);

  const { white: whiteClock, black: blackClock, whiteMs, blackMs, whiteLow, blackLow } = useClocks(game);

  /* ------------------------------------------------------------------ */
  /* Authoritative flag-fall: the moment the side to move hits 00:00, ask  */
  /* the store to settle the game as a timeout loss immediately (the      */
  /* server re-validates the clock itself, so this can never end a game   */
  /* early). Polling remains the fallback if this call fails.             */
  /* ------------------------------------------------------------------ */
  const flagMs = turnSide === "white" ? whiteMs : blackMs;
  const flagFallen =
    game?.status === "active" && Boolean(game?.timeControl) && flagMs === 0;
  const timeoutTriggered = useRef(false);

  /* Referentially stable per position: the memoized board compares props,
     and a fresh object literal every render (clock ticks included) would
     defeat the memo and bring the drag hitching back. These two hooks sit
     ABOVE the loading/not-found early returns: a hook after a conditional
     return breaks React's hook ordering on the loading→loaded transition
     and fails the production build outright.

     The deps are the MOVE'S OWN VALUES, not `game`: the hosted store polls
     every 2s and each poll yields a new `game` object, so depending on the
     game object rebuilt `lastMove` — and re-rendered the whole board — on
     every poll even when nothing changed. That was the tournament lag:
     each re-render re-parses the position (new Chess(fen) three or four
     times) right as a player is picking a piece. With primitive deps the
     board re-renders only when the position or the last move really
     changes. */
  const lastMove = useMemo(() => {
    const last = game?.moves[game.moves.length - 1];
    return last ? { from: last.from, to: last.to } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- primitive deps by design; see note above
  }, [game?.moves.length, game?.moves.at(-1)?.from, game?.moves.at(-1)?.to]);
  void lastMove; // superseded by shownLastMove above — kept for the memo pattern note

  const handleBoardMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (touchDeviceRef.current) {
        pendingScrollRef.current = window.scrollY;
      }
      void submitMove(from, to, promotion);
    },
    [submitMove],
  );

  useEffect(() => {
    if (!flagFallen) {
      timeoutTriggered.current = false;
      return;
    }
    if (timeoutTriggered.current) return;
    timeoutTriggered.current = true;
    void resolveTimeout();
  }, [flagFallen, resolveTimeout]);

  /* ------------------------------------------------------------------ */
  /* Tournament presence: check in the moment a live tournament board is */
  /* open. The server starts the clock only when BOTH players have       */
  /* arrived (or the absence grace expires), so nobody sits down to a    */
  /* half-drained clock. Casual games are unaffected — the server no-ops */
  /* for them.                                                           */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (!game || game.status !== "active" || !game.opponent || !mySide) return;
    if (game.clockStartedAt) return;
    void arrive();
  }, [game?.id, game?.status, game?.clockStartedAt, mySide, arrive]);

  /** The clock is gated on presence and at least one player is not in yet. */
  const clockWaiting =
    game?.status === "active" &&
    Boolean(game?.opponent) &&
    !game?.clockStartedAt &&
    game?.arrivedAt !== undefined;

  if (loading) {
    return (
      <div className="shell flex flex-col px-4 py-4 sm:px-6 lg:h-[calc(100dvh-var(--nav-h))] lg:py-4">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="mx-auto w-full space-y-2.5">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="aspect-square w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!game) {
    const reason = isLocalGameId(id)
      ? "This game only exists in the browser that created it. Open that tab, or start a new game."
      : isHostedGameId(id)
        ? "No game with this id. The link may be expired or mistyped."
        : "Game not found. It may still be finalising.";
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-24 text-center">
        <AlertCircle className="h-9 w-9 text-destructive" aria-hidden />
        <h1 className="font-display mt-4 text-2xl font-bold tracking-tight">Game not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {error ?? reason}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button onClick={() => (window.location.href = "/create")}>Create a game</Button>
          <Link
            href="/solo"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            <Bot aria-hidden />
            Play vs AI
          </Link>
          <Button variant="ghost" onClick={() => (window.location.href = "/")}>
            Back home
          </Button>
        </div>
      </div>
    );
  }

  const waiting = game.status === "waiting";
  /**
   * A directed challenge belongs to the player it was sent to — holding the link
   * doesn't make you the opponent (the server enforces this too). So a stranger
   * looking at one is a spectator, not someone we invite to "Join as Black".
   */
  const challengeToSomeoneElse =
    waiting && Boolean(game.invited) && game.invited !== myId;
  /** Waiting, and this viewer really can sit down as Black. */
  const canJoinAsBlack = waiting && mySide === null && !challengeToSomeoneElse;
  /* Reviewing a past position mid-game locks the board: the input would
     otherwise target the live position while the player is looking at an
     older one. Follow the moves back to live to keep playing. */
  const interactive =
    !waiting && !gameOver && !reviewing && mySide !== null && myTurn && busy !== "move";
  /**
   * Premoves: while it is the opponent's move, own-piece clicks and drops
   * queue a move that plays the instant the turn arrives. Live two-player
   * games only — a spectator has no pieces, and replay/waiting have no
   * next turn to queue into.
   */
  const allowPremove =
    !waiting && !gameOver && !reviewing && mySide !== null && !myTurn && busy !== "move";
  const baseOrientation: "white" | "black" = mySide === "black" ? "black" : "white";
  const orientation: "white" | "black" = flipped
    ? baseOrientation === "white"
      ? "black"
      : "white"
    : baseOrientation;
  const spectator = mySide === null && !waiting;
  const aiThinking = isAiGame && game.status === "active" && !myTurn;
  const moveNumber = Math.floor(game.moves.length / 2) + 1;

  // Draw offer state: who offered, and whether the viewer can respond.
  // Draws need a human opponent on the shared store — the on-device AI has
  // no reply path and the on-chain store doesn't support offers yet.
  const drawSupported = game.backend !== "genlayer" && !isAiGame;
  const drawOffer = game.drawOffer;
  const drawOfferFromMe = drawOffer !== undefined && drawOffer.by === myId;
  const drawOfferFromOpponent =
    drawOffer !== undefined && mySide !== null && drawOffer.by !== myId;

  const playerName = (playerId: string) => {
    // The computer opponent is a named player, chess.com-style.
    if (playerId === AI_PLAYER_ID) return aiLevelFor(game?.aiDifficulty).name;
    if (playerId === myId) return identity.username || undefined;
    return profiles[playerId]?.username;
  };
  const playerRating = (playerId: string) => {
    // Computer opponents carry the rating of their difficulty level.
    if (playerId === AI_PLAYER_ID) return aiLevelFor(game?.aiDifficulty).rating;
    // Humans always have a rating — real value when known, provisional 1200
    // for guests / before the profile fetch resolves.
    return profiles[playerId]?.rating ?? 1200;
  };

  const inCheck = pos?.inCheck ?? false;

  /* The result, described once and reused by the banner below and by the
     end-game modal — so the page always says how the game ended even after
     the modal is dismissed. */
  const result = gameOver ? describeResult(game, mySide) : null;

  /**
   * One player card, addressed by chess colour rather than screen position, so
   * the caller can place it above or below the board according to the current
   * board orientation.
   */
  const playerCardFor = (side: "white" | "black") => {
    const isWhite = side === "white";
    const playerId = isWhite ? game.creator : game.opponent;
    return (
      <PlayerCard
        side={side}
        playerId={playerId}
        name={playerName(playerId)}
        avatarUrl={profiles[playerId]?.avatarUrl}
        country={profiles[playerId]?.country}
        rating={playerRating(playerId)}
        clock={isWhite ? whiteClock : blackClock}
        clockLow={isWhite ? whiteLow : blackLow}
        isYou={mySide === side}
        isWinner={winnerSide === side}
        isTurn={!replayMode && turnSide === side && !gameOver && !waiting}
        inCheck={inCheck && turnSide === side}
        waiting={waiting && !game.opponent}
        /* Read off the position on screen, so the trays rewind with the board
           during a replay instead of always showing the final material. */
        captures={
          <CaptureTray
            fen={boardFen ?? game.fen}
            side={side}
            pieceSet={pieceSet}
          />
        }
      />
    );
  };

  const currentPly = replayMode || reviewing ? (ply ?? 0) - 1 : game.moves.length - 1;
  const movesSection = (
    <MoveHistory
      moves={game.moves}
      currentPly={currentPly}
      /* Clicking a move walks the board to that moment — live or after the
         game. While it's your turn the input is locked until you follow the
         moves back to live (the banner under the board says so). */
      onSelectPly={(p) => setPly(p >= game.moves.length ? (gameOver ? p : null) : p)}
    />
  );

  /* Board + replay controls, defined once and mounted twice: under the
     board on mobile, inside the match console on desktop — where the board
     owns the whole column so the square can use the full viewport height.
     CSS shows exactly one mount per breakpoint. */
  const boardControls = (
    <>
          {/* Board controls / replay controls — flip the board anytime */}
          {replayMode && game && (
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-card/40 px-2 py-1.5">
              <BoardSettings
                boardTheme={boardTheme}
                pieceSet={pieceSet}
                onBoardTheme={setBoardTheme}
                onPieceSet={setPieceSet}
              />
              <div className="mx-auto flex items-center gap-1">
                <Button size="icon" variant="ghost" onClick={() => setPly(0)} disabled={ply === 0} aria-label="First move">
                  <SkipBack aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setPly((p) => Math.max(0, (p ?? 0) - 1))} disabled={ply === 0} aria-label="Previous move">
                  <ChevronLeft aria-hidden />
                </Button>
                <span className="w-24 text-center font-mono text-xs tabular-nums text-muted-foreground">
                  {ply ?? 0} / {game.moves.length}
                </span>
                <Button size="icon" variant="ghost" onClick={() => setPly((p) => Math.min(game.moves.length, (p ?? 0) + 1))} disabled={ply === game.moves.length} aria-label="Next move">
                  <ChevronRight aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setPly(game.moves.length)} disabled={ply === game.moves.length} aria-label="Last move">
                  <SkipForward aria-hidden />
                </Button>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setFlipped((f) => !f)} aria-label="Flip board" title="Flip board">
                <RefreshCw aria-hidden />
              </Button>
            </div>
          )}

          {/* Live actions — or, while stepped back, the review controls. The
              review row replaces the action row entirely: pieces can't be
              moved from a past position, so the row's job is to get you back
              to the present. */}
          {!replayMode && (
            <div className="shrink-0 space-y-1.5">
              {reviewing ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setPly(Math.max(0, (ply ?? 0) - 1))}
                      disabled={ply === 0}
                      aria-label="Previous move"
                    >
                      <ChevronLeft aria-hidden />
                    </Button>
                    <span className="min-w-24 text-center font-mono text-xs tabular-nums text-muted-foreground">
                      {ply} / {game.moves.length}
                    </span>
                    {/* Forward past the last played move IS live: no separate
                        button, no special state — the board simply catches up
                        and stays caught up (the snap effect above re-engages
                        once ply === moves.length). */}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setPly(ply! + 1 >= game.moves.length ? null : ply! + 1)
                      }
                      aria-label="Next move"
                    >
                      <ChevronRight aria-hidden />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setPly(0)}
                      disabled={ply === 0}
                      aria-label="Back to the start"
                    >
                      <SkipBack aria-hidden />
                    </Button>
                  </div>
                  <span className="text-2xs uppercase tracking-wider text-muted-foreground">
                    reviewing move {ply} of {game.moves.length}
                  </span>
                </div>
              ) : (
              <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  {/* Step back through the moves while the game is live — catch
                      up on what you missed, then jump forward to the present. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={game.moves.length === 0}
                    onClick={() => setPly(game.moves.length - 1)}
                    className="gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-label="Review previous moves"
                  >
                    <SkipBack className="h-3.5 w-3.5" aria-hidden />
                    Last move
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFlipped((f) => !f)}
                    className="gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-label="Flip board"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    Flip
                  </Button>
                  <BoardSettings
                    boardTheme={boardTheme}
                    pieceSet={pieceSet}
                    onBoardTheme={setBoardTheme}
                    onPieceSet={setPieceSet}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {game.moves.length === 0 && mySide && (game.status === "waiting" || game.status === "active") && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void abort()}
                    >
                      {busy === "abort" ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Ban aria-hidden />
                      )}
                      Abort game
                    </Button>
                  )}
                  {game.status === "active" && drawSupported && mySide && drawOfferFromOpponent && (
                    <>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void respondDraw(true)}
                      >
                        {busy === "draw-respond" ? (
                          <Loader2 className="animate-spin" aria-hidden />
                        ) : (
                          <Handshake aria-hidden />
                        )}
                        Accept draw
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void respondDraw(false)}
                      >
                        Decline
                      </Button>
                    </>
                  )}
                  {game.status === "active" && drawSupported && mySide && !drawOffer && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void offerDraw()}
                    >
                      {busy === "draw-offer" ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Handshake className="h-3.5 w-3.5" aria-hidden />
                      )}
                      Offer draw
                    </Button>
                  )}
                  {game.status === "active" && mySide && game.moves.length > 0 && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void resign()}
                    >
                      {busy === "resign" ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Flag aria-hidden />
                      )}
                      Resign
                    </Button>
                  )}
                  {canJoinAsBlack && (
                    <Button size="sm" disabled={busy !== null} onClick={() => void join()}>
                      {busy === "join" ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Users aria-hidden />
                      )}
                      Join as Black
                    </Button>
                  )}
                </div>
              </div>
              <p
                className={cn(
                  /* One line, always: this sits directly under the board in a
                     height-budgeted column, so a wrap here would push the
                     board smaller as the text changed. */
                  "truncate text-xs text-muted-foreground",
                  game.status === "active" && !interactive && mySide && !busy && "animate-pulse-soft",
                )}
              >
                {canJoinAsBlack
                  ? "You'll play Black once you join."
                  : challengeToSomeoneElse
                    ? "This is a private challenge between two players."
                    : game.status === "active" && mySide === null
                    ? "Spectating: the game updates live."
                    : clockWaiting
                    ? "The clock starts when both players are at the board."
                    : game.status === "active" && drawSupported && drawOfferFromMe
                      ? "Draw offered: waiting for your opponent's reply."
                      : game.status === "active" && drawSupported && drawOfferFromOpponent
                        ? "Opponent offered a draw: accept or decline above."
                        : game.status === "active" && aiThinking
                          ? `${aiLevelFor(game?.aiDifficulty).name} is thinking…`
                          : game.status === "active" && !myTurn
                            ? "Waiting for your opponent to move…"
                            : game.status === "active" && myTurn
                              ? "Your turn: click a piece, then a destination."
                              : ""}
              </p>
              </>
            )}
            </div>
          )}
    </>
  );

  const gameInfo = (
    <div className="border-t border-border/60">
      <div className="px-4 py-2.5">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Game info
        </span>
      </div>
      <dl className="space-y-1.5 px-4 pb-3 text-xs">
        {game.timeControl && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Time control</dt>
            <dd className="font-mono tabular-nums text-foreground/85">{game.timeControl}</dd>
          </div>
        )}
        {game.visibility && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Visibility</dt>
            <dd className="capitalize text-foreground/85">{game.visibility}</dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Mode</dt>
          <dd className="capitalize text-foreground/85">
            {isAiGame ? "vs Computer" : "Online"}
          </dd>
        </div>
        {game.endedAt && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Ended</dt>
            <dd className="tabular-nums text-foreground/85">
              {new Date(game.endedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );

  return (
    /* The game screen is an app shell, not a document. On desktop it is exactly
       one viewport tall — the board is sized off the viewport height (see
       --board-chrome in globals.css) and the match console scrolls inside
       itself — so a live game never scrolls the page out from under a player
       mid-move. Below `lg` it falls back to normal document flow, because a
       phone cannot fit a usable board and a readable console at once. */
    <div className="shell flex flex-col px-4 py-4 sm:px-6 lg:h-[calc(100dvh-var(--nav-h))] lg:py-4">
      {/* Header */}
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-3">
        <img src="/logo-mark.svg" alt="" className="h-6 w-6" />
        <div>
          <h1 className="font-display text-lg font-bold tracking-tight">
            {gameOver ? "Match report" : "Chess match"}
          </h1>
          <p className="text-2xs text-muted-foreground">
            {isAiGame ? "vs Computer" : "Online match"}
            {game.timeControl ? ` · ${game.timeControl}` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!gameOver && <StatusBar game={game} turnSide={turnSide} inCheck={inCheck} />}
          {spectator && <Badge variant="secondary">spectating</Badge>}
          {/* Escape hatch — but BACK, never Home: a mis-click mid-game must
              not eject a player to the landing page and cost them their
              navigation trail. This returns to wherever they came from
              (tournament page, play list, create form…). router.back() needs
              history to exist, so it falls back to the play hub. */}
          <button
            type="button"
            onClick={() => {
              if (window.history.length > 1) router.back();
              else router.push("/play");
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Back
          </button>
        </div>
      </div>

      {/* Action error banner + result strip. They sit above the board column;
          the board meter measures the column's viewport position directly, so
          everything above it (nav, header, these banners) is budgeted without
          a separate measurement pass. */}
      {error && (
        <div className="mb-2 flex shrink-0 items-start gap-2.5 rounded-md bg-destructive/10 px-3 py-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-destructive">Something went wrong</p>
            <p className="mt-0.5 text-xs leading-snug text-destructive/90">{error}</p>
          </div>
        </div>
      )}

      {/* Persistent result — the modal is dismissible, this is not. It is the
          page's own record of how the match ended, and it can bring the full
          report back at any time. Kept to a single quiet line: the verdict
          carries the emphasis, everything else is secondary text on the page
          background rather than another heavy bordered box. */}
      {result && (
        <div
          className={cn(
            "animate-fade-in-up mb-2 flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-3 py-2",
            result.won
              ? "bg-primary/[0.07]"
              : result.lost
                ? "bg-negative/[0.07]"
                : "bg-secondary/30",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              result.won
                ? "bg-primary"
                : result.lost
                  ? "bg-negative"
                  : "bg-muted-foreground",
            )}
          />
          <p className="text-sm font-semibold tracking-tight">
            {result.verdict}
            <span className="ml-1.5 font-normal text-muted-foreground">{result.reason}</span>
          </p>
          <p className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
            {result.detail}
          </p>
          {!resultOpen && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto shrink-0 text-xs"
              onClick={() => setResultOpen(true)}
            >
              Full report
            </Button>
          )}
        </div>
      )}
      {/* Board and match console share one row on desktop. The board column
          takes the shell's full width; the SQUARE is capped by the height the
          column's non-board chrome (player cards, controls, banners) leaves —
          measured at runtime, never estimated. The console fills what's left
          and scrolls inside itself. Below `lg` it stacks: moves live directly
          under the board, full width, at every breakpoint. */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row lg:gap-6">
        {/* The board column is width-driven at every breakpoint. Its height
            budget (viewport − header − banners − its own chrome) is measured
            by BoardChromeMeter and published as --board-w, which the square
            reads — so the board is as big as the screen allows and never a
            pixel taller than the fold. */}
        {/* The board column hugs its square: w-full only while stacked (the
            column IS the width below lg). At lg, w-full claimed a flex basis
            of 100%, and with the console's flex-1 (basis 0) the shrink math
            collapsed the CONSOLE to zero width — nothing ever appeared
            beside the board. lg:w-auto lets it shrink-to-fit --board-w and
            hand the leftover width to the console. */}
        <div
          className="flex w-full min-w-0 flex-col items-center gap-2 lg:w-auto"
          ref={boardRef}
        >
          {/* Player cards follow the board, always. The side shown at the
              BOTTOM of the board is `orientation` (react-chessboard puts that
              colour's home rank nearest the viewer), so its card belongs
              below the board and the opponent's above. */}
          <div className="w-full lg:hidden" style={{ maxWidth: "var(--board-w, 36rem)" }}>
            {playerCardFor(orientation === "white" ? "black" : "white")}
          </div>
          <div
            data-board-root
            className="w-full overflow-hidden rounded-md ring-1 ring-border/40"
            style={{ maxWidth: "var(--board-w, 36rem)" }}
          >
            <ChessBoard
              fen={boardFen ?? game.fen}
              orientation={orientation}
              interactive={!replayMode && interactive}
              inCheck={inCheck}
              lastMove={shownLastMove}
              pieceSet={pieceSet}
              allowPremove={allowPremove}
              onMove={handleBoardMove}
              busy={busy === "move"}
            />
          </div>
          <div className="w-full lg:hidden" style={{ maxWidth: "var(--board-w, 36rem)" }}>
            {playerCardFor(orientation)}
          </div>

          {/* The move strip: directly under the board on mobile, full width of
              the board container. Desktop keeps it in the console. */}
          <div className="w-full lg:hidden" style={{ maxWidth: "var(--board-w, 36rem)" }}>
            {movesSection}
          </div>

          {/* Board controls (mobile position). Desktop renders the same block
              inside the match console — the board column stays nothing but the
              square, so --board-w can hand it the full viewport height. */}
          <div className="lg:hidden">{boardControls}</div>
        </div>

        <BoardChromeMeter columnRef={boardRef} />

        {/* Match console — beside the board on desktop, filling the leftover
            width; below the board on mobile. It scrolls inside itself so the
            page never scrolls a live game out from under the player. */}
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-3 lg:h-full lg:max-w-[26rem] lg:flex-none lg:overflow-y-auto lg:pb-1">
          {/* Desktop: the board column is nothing but the square, so the
              cards, controls and moves live here — opponent on top, you at
              the bottom, mirroring the board. This is what buys the square
              its full viewport-height budget. */}
          <div className="hidden w-full min-w-0 flex-col gap-3 lg:flex">
            {playerCardFor(orientation === "white" ? "black" : "white")}
            {playerCardFor(orientation)}
            {boardControls}
            {movesSection}
          </div>
          {waiting && mySide === "white" && (
            <WaitingPanel
              gameId={game.id}
              challenge={Boolean(game.invited)}
            />
          )}
          {canJoinAsBlack && (
            <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3 text-sm text-muted-foreground">
              The creator of this game hasn&rsquo;t been matched yet. Join as Black
              to start playing.
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border/70 bg-card/50">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
              <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {!gameOver && game.status === "active" && (
                  <span className="relative flex h-1.5 w-1.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                )}
                {gameOver ? "Match report" : "Match"}
              </span>
              <span className="font-mono text-xs tabular-nums text-foreground/80">
                {replayMode ? `Move ${Math.min(ply ?? 0, game.moves.length)}` : `Move ${moveNumber}`}
              </span>
            </div>

            {/* The move history lives under the board (see the board column);
                this console carries the info and chat. */}
            {gameInfo}

            {/* Two humans talking while they play — spectators and AI games
                never see this (the component renders null). */}
            <GameChat
              gameId={game.id}
              enabled={!isAiGame && !spectator && !canJoinAsBlack && game.opponent !== ""}
            />
          </div>
        </div>
      </div>

      {/* Post-game result modal — appears the moment the game ends. The
          tournamentId prop is what kills the rematch button: the modal swaps
          its actions for "Back to tournament", because the bracket decides
          what happens next, not the players. */}
      {gameOver && resultOpen && (
        <EndGameModal
          game={game}
          stats={profiles}
          myPlayerId={myId}
          mySide={mySide}
          analyzing={false}
          tournamentId={game.tournamentId}
          onRematch={
            // TOURNAMENT GAMES NEVER OFFER A REMATCH: the event's bracket
            // decides what happens next (next round, or the event is over
            // for you) — a casual re-match would be meaningless and confusing
            // right where the result just landed.
            game.tournamentId
              ? undefined
              : isAiGame
                ? async () => {
                    // Fresh game against the same computer opponent, same level
                    // and clock. The colour draw is random again, exactly like
                    // starting from the AI page.
                    const next = await getStore("local").createAiGame(
                      game.aiDifficulty ?? "casual",
                      game.timeControl ? { timeControl: game.timeControl } : undefined,
                    );
                    router.push(`/game/${next.id}`);
                  }
                : game.backend === "hosted"
                  ? async () => {
                      const next = await rematch();
                      router.push(`/game/${next.id}`);
                    }
                  : undefined
          }
          onReplay={() => {
            setResultOpen(false);
            startReplay();
          }}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Publishes the board square's true budget as `--board-w` (px) on the
 * document root — the column and board read it as their max width.
 *
 * Desktop: the square is min(66vw, the column's measured height budget) —
 * a square can never be wider than the height the screen gives it, or the
 * bottom rank clips under the fold. The height side is el.clientHeight (the
 * column is flex-stretched to the row's height, so that IS the viewport
 * budget) minus the live-measured chrome (player cards, controls, move
 * strip, banners), never an estimate that drifts as rows are added.
 * Mobile: width-driven — the board fills the column like any phone layout
 * expects; no viewport-height budget and no 66vw cap apply there.
 * Re-measures on resize and on any content change; renders null.
 */
function BoardChromeMeter({
  columnRef,
}: {
  columnRef: React.RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const root = el.ownerDocument.documentElement;
    const publish = () => {
      const vw = root.clientWidth;
      const row = el.parentElement;
      // Desktop = the flex row lays out horizontally (lg:flex-row); below lg
      // it stacks and the page scrolls normally.
      const desktop = row
        ? getComputedStyle(row).flexDirection.startsWith("row")
        : vw >= 1024;

      let budget: number;
      if (desktop) {
        // The column is STRETCHED to the row's height, so el.clientHeight is
        // the true viewport budget regardless of how tall its content is —
        // comparing the row's rect to the column's never fires (they are the
        // same box), which is how the board recently grew past the fold.
        // Budget = that height − every non-board row (player cards, controls,
        // move strip) − the gaps between rows, capped at 66vw.
        let chrome = 0;
        let visibleRows = 0;
        for (const child of Array.from(el.children)) {
          if (child.hasAttribute("data-board-root")) continue;
          // display:none children (the mobile-only chrome on desktop) occupy
          // nothing and must not eat budget — their rects read as 0 but the
          // old gap count still charged for them.
          if ((child as HTMLElement).offsetHeight === 0) continue;
          chrome += child.getBoundingClientRect().height;
          visibleRows += 1;
        }
        const gaps = visibleRows * 8;
        budget = Math.min(vw * 0.66, Math.max(352, el.clientHeight - chrome - gaps));
      } else {
        // Mobile is width-driven: the board fills the column — the 66vw cap
        // is a desktop layout notion and shrank the phone board to two thirds
        // of the screen.
        budget = el.clientWidth || vw;
      }
      if (Number.isFinite(budget) && budget > 0) {
        root.style.setProperty("--board-w", `${Math.round(budget)}px`);
      }
    };
    publish();
    const ro = new ResizeObserver(publish);
    for (const child of Array.from(el.children)) ro.observe(child);
    ro.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--board-w");
    };
  }, [columnRef]);

  return null;
}

