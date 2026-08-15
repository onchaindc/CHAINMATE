"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Bot, Flag, Loader2, Users } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChessBoard } from "@/components/game/chess-board";
import { CommentaryPanel } from "@/components/game/commentary-panel";
import { GameOverPanel } from "@/components/game/game-over-panel";
import { MoveHistory } from "@/components/game/move-history";
import { PlayerCard } from "@/components/game/player-card";
import { StatusBar } from "@/components/game/status-bar";
import { WaitingPanel } from "@/components/game/waiting-panel";
import { useAiCommentary } from "@/hooks/use-ai-commentary";
import { useAiOpponent } from "@/hooks/use-ai-opponent";
import { useGame } from "@/hooks/use-game";
import { isHostedGameId, isLocalGameId } from "@/lib/config";
import { AI_PLAYER_ID, isGameOver, shortId } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function GamePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const {
    game,
    loading,
    error,
    busy,
    pos,
    mySide,
    turnSide,
    myTurn,
    winnerSide,
    join,
    submitMove,
    submitAiMove,
    resign,
    generateSummary,
  } = useGame(id);

  const { insight, loading: aiLoading, enabled: aiEnabled } = useAiCommentary(game);
  const isAiGame = game?.opponent === AI_PLAYER_ID;
  useAiOpponent({ game, submitAiMove, disabled: busy !== null });

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="aspect-square w-full rounded-xl" />
            <Skeleton className="h-14 w-full" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
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
        <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
        <h1 className="font-display mt-4 text-2xl font-bold">Game not found</h1>
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
  const gameOver = isGameOver(game.status);
  const interactive = !waiting && !gameOver && mySide !== null && myTurn && busy !== "move";
  const orientation: "white" | "black" = mySide === "black" ? "black" : "white";
  const lastMove = game.moves.length
    ? { from: game.moves[game.moves.length - 1].from, to: game.moves[game.moves.length - 1].to }
    : null;
  const spectator = mySide === null && !waiting;
  const aiThinking = isAiGame && game.status === "active" && !myTurn;

  const aiHint = aiEnabled
    ? null
    : "Set NEXT_PUBLIC_AI_ENABLED=true and an AI_API_KEY to unlock deeper LLM commentary.";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight">Chess match</h1>
          <p className="font-mono text-xs text-muted-foreground">{shortId(game.id)}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatusBar game={game} turnSide={turnSide} inCheck={pos?.inCheck ?? false} />
          {spectator && <Badge variant="secondary">spectating</Badge>}
        </div>
      </div>

      {/* Action error banner */}
      {error && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-destructive">Something went wrong</p>
            <p className="mt-0.5 text-xs leading-snug text-destructive/90">{error}</p>
          </div>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Board column */}
        <div className="mx-auto w-full max-w-[640px] space-y-3 lg:mx-0">
          <PlayerCard
            side="white"
            playerId={game.creator}
            isYou={mySide === "white"}
            isWinner={winnerSide === "white"}
            isTurn={turnSide === "white" && !gameOver && !waiting}
            waiting={waiting && !game.opponent}
          />
          <ChessBoard
            fen={game.fen}
            orientation={orientation}
            interactive={interactive}
            inCheck={pos?.inCheck ?? false}
            lastMove={lastMove}
            onMove={(from, to, promotion) => {
              void submitMove(from, to, promotion);
            }}
            busy={busy === "move"}
          />
          <PlayerCard
            side="black"
            playerId={game.opponent}
            isYou={mySide === "black"}
            isWinner={winnerSide === "black"}
            isTurn={turnSide === "black" && !gameOver && !waiting}
            waiting={waiting && !game.opponent}
          />

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {game.status === "active" && mySide && (
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
            {waiting && mySide === null && (
              <Button size="lg" disabled={busy !== null} onClick={() => void join()} className="w-full">
                {busy === "join" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Users aria-hidden />
                )}
                Join as Black
              </Button>
            )}
            <p
              className={cn(
                "text-xs text-muted-foreground",
                game.status === "active" && !interactive && mySide && !busy && "animate-pulse-soft",
              )}
            >
              {waiting && mySide === null
                ? "You'll play Black once you join."
                : game.status === "active" && mySide === null
                  ? "Spectating — the game updates live."
                  : game.status === "active" && aiThinking
                    ? "The AI is thinking…"
                    : game.status === "active" && !myTurn
                      ? "Waiting for your opponent to move…"
                      : game.status === "active" && myTurn
                        ? "Your turn — click a piece, then a destination."
                        : gameOver
                          ? "The game has ended."
                          : ""}
            </p>
          </div>
        </div>

        {/* Side column */}
        <div className="space-y-4">
          {waiting ? (
            mySide === "white" ? (
              <WaitingPanel gameId={game.id} local={isLocalGameId(game.id)} />
            ) : (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  The creator of this game hasn&rsquo;t been matched yet. Join as
                  Black to start playing.
                </CardContent>
              </Card>
            )
          ) : null}

          {gameOver && (
            <GameOverPanel game={game} busy={busy === "summary"} onGenerateSummary={generateSummary} />
          )}

          <MoveHistory moves={game.moves} currentPly={game.moves.length - 1} />
          <CommentaryPanel
            entries={game.commentary}
            aiInsight={insight}
            aiLoading={aiLoading}
            aiEnabled={aiEnabled}
            aiHint={aiHint}
          />
        </div>
      </div>
    </div>
  );
}
