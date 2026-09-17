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
import { EndGameModal } from "@/components/game/end-game-modal";
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

type MobileTab = "moves" | "info";

const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "moves", label: "Move history" },
  { id: "info", label: "Match info" },
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
  const modalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!game || !gameOver) return;
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
          <div className="mx-auto w-full max-w-[640px] space-y-2.5 lg:max-w-[min(100%,64rem,max(18rem,calc(100dvh-var(--nav-h)-var(--board-chrome))))]">
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
    <div className="mx-auto flex w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:h-[calc(100dvh-var(--nav-h))] lg:py-5">
      {/* Header */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3">
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
          {/* Escape hatch: the game fills the viewport, so a stuck player
              needs an explicit way out that doesn't depend on browser chrome. */}
          <Link
            href="/"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Home
          </Link>
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

      {/* Board and match console share one row on desktop: the board is a
          square, so its size is capped by the space left over VERTICALLY (nav,
          header, player cards, controls — see --board-chrome in globals.css) —
          that is the largest fully-visible board the screen allows. The
          leftover width goes to the match console, which scrolls inside
          itself. Nothing here exceeds the viewport, and no horizontal space
          is wasted on empty margins either. Below `lg` it stacks: a phone
          cannot fit a usable board and a readable console at once. */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row lg:gap-8">
        {/* The board column's WIDTH is the viewport-height budget on desktop:
            a square board can never be wider than the height it is allowed,
            or it overflows the fold. It is also capped at 56rem so on very
            tall monitors the match console keeps a readable column instead of
            being squeezed to nothing. Mobile stays width-driven. */}
        <div
          className="mx-auto flex w-full min-w-0 flex-col gap-2.5 lg:h-full lg:w-[min(100%,64rem,max(18rem,calc(100dvh-var(--nav-h)-var(--board-chrome))))] lg:flex-none"
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
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setPly(ply === game.moves.length - 1 ? null : ply! + 1)}
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
                  <Button
                    size="sm"
                    onClick={() => setPly(null)}
                    className="gap-1.5"
                  >
                    <SkipForward aria-hidden />
                    Back to live
                  </Button>
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
                    Back
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
        </div>

        {/* Match console — beside the board on desktop, filling the leftover
            width; below the board on mobile. It scrolls inside itself so the
            page never scrolls a live game out from under the player. */}
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-3 lg:h-full lg:max-w-[60rem] lg:flex-1 lg:overflow-y-auto lg:pb-1">
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

            {movesSection}
            {gameInfo}
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
            isAiGame
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
