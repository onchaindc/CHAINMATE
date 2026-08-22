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
  Trophy,
  Users,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BoardSettings } from "@/components/game/board-settings";
import { CaptureTray } from "@/components/game/capture-tray";
import { ChessBoard } from "@/components/game/chess-board";
import { CommentaryPanel } from "@/components/game/commentary-panel";
import { EndGameModal } from "@/components/game/end-game-modal";
import { MoveHistory } from "@/components/game/move-history";
import { PlayerCard } from "@/components/game/player-card";
import { StatusBar } from "@/components/game/status-bar";
import { WaitingPanel } from "@/components/game/waiting-panel";
import { useAiCommentary } from "@/hooks/use-ai-commentary";
import { useAiOpponent } from "@/hooks/use-ai-opponent";
import { useBoardPrefs } from "@/hooks/use-board-prefs";
import { useClocks } from "@/hooks/use-clocks";
import { useGame } from "@/hooks/use-game";
import { useIdentity } from "@/lib/identity-context";
import { fenAfterPly } from "@/lib/chess";
import { isHostedGameId, isLocalGameId } from "@/lib/config";
import { describeResult } from "@/lib/game-result";
import { AI_PLAYER_ID, aiLevelFor, isGameOver, type PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

type MobileTab = "moves" | "analysis" | "info";

const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "moves", label: "Moves" },
  { id: "analysis", label: "Analysis" },
  { id: "info", label: "Match" },
];

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
    generateSummary,
    analyzing,
  } = useGame(id);

  const { insight, status: aiStatus, retry: retryAnalysis, enabled: aiEnabled } = useAiCommentary(game);
  const isAiGame = game?.opponent === AI_PLAYER_ID;
  useAiOpponent({ game, submitAiMove, disabled: busy !== null });

  const gameOver = game ? isGameOver(game.status) : false;

  /* ------------------------------------------------------------------ */
  /* State-aware replay: when the game ends, the board becomes a replay  */
  /* on the same URL. ?replay=1 links land the same way.                 */
  /* ------------------------------------------------------------------ */
  const [ply, setPly] = useState<number | null>(null);
  const replayMode = gameOver && ply !== null;

  useEffect(() => {
    if (game && gameOver && ply === null) {
      setPly(game.moves.length);
    }
  }, [game, gameOver, ply]);

  // Keyboard navigation while replaying (←/→/Home/End).
  useEffect(() => {
    if (!replayMode || !game) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, (p ?? 0) - 1));
      else if (e.key === "ArrowRight") setPly((p) => Math.min(game.moves.length, (p ?? 0) + 1));
      else if (e.key === "Home") setPly(0);
      else if (e.key === "End") setPly(game.moves.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replayMode, game]);

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
  /* Post-game modal: appears automatically when the game ends — once.    */
  /* ------------------------------------------------------------------ */
  const [resultOpen, setResultOpen] = useState(false);
  /**
   * Which result this page has already announced ("<game id>:<status>").
   * Without it the modal re-opened on every render where `gameOver` had just
   * become true again, so a player who dismissed it got it back seconds later
   * — and a late poll landing an older snapshot made it flicker between
   * results. The result banner below stays put regardless, so closing the
   * modal never loses the information.
   */
  const announcedResult = useRef<string | null>(null);
  useEffect(() => {
    if (!game || !gameOver) return;
    const key = `${game.id}:${game.status}`;
    if (announcedResult.current === key) return;
    announcedResult.current = key;
    setResultOpen(true);
  }, [game, gameOver]);

  /* ------------------------------------------------------------------ */
  /* Mobile: the match console shows one section at a time.              */
  /* ------------------------------------------------------------------ */
  const [mobileTab, setMobileTab] = useState<MobileTab>("moves");
  useEffect(() => {
    setMobileTab("moves");
  }, [id]);

  /* Board control: flip the board (useful for spectators and for reviewing
     the game from the opponent's point of view). Local view state only. */
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    setFlipped(false);
  }, [id]);

  /* Board colours and piece artwork, remembered across sessions per player. */
  const { boardTheme, pieceSet, setBoardTheme, setPieceSet } = useBoardPrefs();

  const boardFen = useMemo(() => {
    if (replayMode && game && ply !== null) return fenAfterPly(game.moves, ply);
    return game?.fen ?? null;
  }, [replayMode, game, ply]);

  const replayLastMove = useMemo(() => {
    if (!replayMode || !game || !ply) return null;
    const m = game.moves[ply - 1];
    return m ? { from: m.from, to: m.to } : null;
  }, [replayMode, game, ply]);

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
  useEffect(() => {
    if (!flagFallen) {
      timeoutTriggered.current = false;
      return;
    }
    if (timeoutTriggered.current) return;
    timeoutTriggered.current = true;
    void resolveTimeout();
  }, [flagFallen, resolveTimeout]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6 lg:py-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="mx-auto w-full max-w-[640px] space-y-2.5 lg:max-w-[min(100%,max(18rem,calc(100dvh-var(--nav-h)-var(--board-chrome))))]">
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
      ? "This game was created in local mode, so it only exists in the browser where it was created. Open the original tab to keep playing — or start a fresh game."
      : isHostedGameId(id)
        ? "This game could not be found in the shared store. The link may be stale or the id mistyped — create a new game and share the fresh invite."
        : "This on-chain game could not be found on the network. It may still be finalising, or the id is wrong.";
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
            href="/create?mode=ai"
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
  const interactive = !waiting && !gameOver && mySide !== null && myTurn && busy !== "move";
  const baseOrientation: "white" | "black" = mySide === "black" ? "black" : "white";
  const orientation: "white" | "black" = flipped
    ? baseOrientation === "white"
      ? "black"
      : "white"
    : baseOrientation;
  const lastMove = game.moves.length
    ? { from: game.moves[game.moves.length - 1].from, to: game.moves[game.moves.length - 1].to }
    : null;
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

  const aiHint = aiEnabled
    ? null
    : "Set NEXT_PUBLIC_AI_ENABLED=true and an AI_API_KEY to unlock deeper LLM commentary.";

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

  const currentPly = replayMode ? (ply ?? 0) - 1 : game.moves.length - 1;
  const movesSection = (
    <MoveHistory
      moves={game.moves}
      currentPly={currentPly}
      /* Jumping the board is only offered once the game is over. Mid-game the
         board has to show the position the players are actually playing —
         anything else invites a move from a position that no longer exists. */
      onSelectPly={gameOver ? (p) => setPly(p) : undefined}
    />
  );
  const analysisSection = (
    <CommentaryPanel
      entries={game.commentary}
      aiInsight={insight}
      aiStatus={aiStatus}
      aiEnabled={aiEnabled}
      aiHint={aiHint}
      onRetry={retryAnalysis}
    />
  );

  const gameInfo = (
    <div className="border-t border-border/60">
      <div className="px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
          <dt className="text-muted-foreground">Backend</dt>
          <dd className="capitalize text-foreground/85">
            {game.backend === "genlayer"
              ? "On-chain"
              : game.backend === "hosted"
                ? "Online"
                : "Local"}
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
    <div className="mx-auto flex w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:h-[calc(100dvh-var(--nav-h))] lg:py-5">
      {/* Header */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3">
        <img src="/logo-mark.svg" alt="" className="h-6 w-6" />
        <div>
          <h1 className="font-display text-lg font-bold tracking-tight">
            {gameOver ? "Match report" : "Chess match"}
          </h1>
          <p className="text-2xs text-muted-foreground">
            {game.backend === "genlayer"
              ? "On-chain match"
              : game.backend === "local"
                ? "Local match"
                : "Online match"}
            {game.timeControl ? ` · ${game.timeControl}` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!gameOver && <StatusBar game={game} turnSide={turnSide} inCheck={inCheck} />}
          {spectator && <Badge variant="secondary">spectating</Badge>}
        </div>
      </div>

      {/* Action error banner */}
      {error && (
        <div className="mb-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-destructive">Something went wrong</p>
            <p className="mt-0.5 text-xs leading-snug text-destructive/90">{error}</p>
          </div>
        </div>
      )}

      {/* Persistent result — the modal is dismissible, this is not. It is the
          page's own record of how the match ended, and it can bring the full
          report back at any time. */}
      {result && (
        <div
          className={cn(
            "animate-fade-in-up mb-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-4 py-2.5",
            result.won
              ? "border-primary/40 bg-primary/10"
              : result.lost
                ? "border-negative/40 bg-negative/10"
                : "border-border/70 bg-secondary/30",
          )}
        >
          <Trophy
            className={cn(
              "h-4 w-4 shrink-0",
              result.won ? "text-primary" : "text-muted-foreground",
            )}
            aria-hidden
          />
          <p className="text-sm font-semibold tracking-tight">
            {result.verdict}
            <span className="ml-1.5 font-normal text-muted-foreground">{result.reason}</span>
          </p>
          <p className="min-w-0 basis-full text-xs leading-snug text-muted-foreground sm:basis-auto">
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

      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Board column — the visual anchor. Its width is capped by the space
            left over vertically, which is what keeps the whole column inside
            one viewport at any window size. */}
        <div
          className="mx-auto flex w-full min-w-0 max-w-[640px] flex-col gap-2.5 lg:max-w-[min(100%,max(18rem,calc(100dvh-var(--nav-h)-var(--board-chrome))))]"
          ref={boardRef}
        >
          {/* Player cards follow the board, always. The side shown at the
              BOTTOM of the board is `orientation` (react-chessboard puts that
              colour's home rank nearest the viewer), so its card belongs
              below the board and the opponent's above.

              These used to be hardcoded black-on-top / white-on-bottom. The
              board itself flipped correctly for Black, so a Black player saw
              their own pieces at the bottom but their own name card at the
              top — the two halves of the screen disagreed about who was who,
              which reads as the whole board being the wrong way round. */}
          {playerCardFor(orientation === "white" ? "black" : "white")}
          <div className="overflow-hidden rounded-md ring-1 ring-border/40">
            <ChessBoard
              fen={boardFen ?? game.fen}
              orientation={orientation}
              interactive={!replayMode && interactive}
              inCheck={inCheck}
              lastMove={replayMode ? replayLastMove : lastMove}
              pieceSet={pieceSet}
              onMove={(from, to, promotion) => {
                if (touchDeviceRef.current) {
                  pendingScrollRef.current = window.scrollY;
                }
                void submitMove(from, to, promotion);
              }}
              busy={busy === "move"}
            />
          </div>
          {playerCardFor(orientation)}

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

          {/* Live actions */}
          {!replayMode && (
            <div className="shrink-0 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
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
                    ? "Spectating — the game updates live."
                    : game.status === "active" && drawSupported && drawOfferFromMe
                      ? "Draw offered — waiting for your opponent's reply."
                      : game.status === "active" && drawSupported && drawOfferFromOpponent
                        ? "Opponent offered a draw — accept or decline above."
                        : game.status === "active" && aiThinking
                          ? `${aiLevelFor(game?.aiDifficulty).name} is thinking…`
                          : game.status === "active" && !myTurn
                            ? "Waiting for your opponent to move…"
                            : game.status === "active" && myTurn
                              ? "Your turn — click a piece, then a destination."
                              : ""}
              </p>
            </div>
          )}
        </div>

        {/* Match console */}
        <div className="flex min-h-0 min-w-0 flex-col gap-3 lg:overflow-y-auto lg:pr-1">
          {waiting && mySide === "white" && (
            <WaitingPanel
              gameId={game.id}
              local={isLocalGameId(game.id)}
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

            {/* Mobile: one section at a time */}
            <div className="flex gap-1 border-b border-border/60 px-2 py-1.5 lg:hidden">
              {MOBILE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setMobileTab(tab.id)}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    mobileTab === tab.id
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Desktop: everything stacked, internally scrollable */}
            <div className="hidden lg:block">
              {movesSection}
              {analysisSection}
              {gameInfo}
            </div>

            {/* Mobile: active tab only */}
            <div className="lg:hidden">
              {mobileTab === "moves" && movesSection}
              {mobileTab === "analysis" && analysisSection}
              {mobileTab === "info" && gameInfo}
            </div>
          </div>
        </div>
      </div>

      {/* Post-game result modal — appears the moment the game ends */}
      {gameOver && resultOpen && (
        <EndGameModal
          game={game}
          stats={profiles}
          myPlayerId={myId}
          mySide={mySide}
          analyzing={analyzing || busy === "summary"}
          onGenerateSummary={generateSummary}
          onRematch={
            game.backend === "hosted" && !isAiGame
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
