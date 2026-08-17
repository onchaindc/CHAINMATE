import { applyChessMove, describePosition } from "@/lib/chess";
import type {
  CommentaryEntry,
  GameState,
  GameStatus,
  PlayerSide,
} from "@/lib/types";
import type { Move } from "chess.js";

/**
 * Pure, framework-free game rules shared by every store that plays chess
 * (local browser store, hosted server store). Move validation mirrors the
 * GenLayer contract (contracts/chainmate.py) via chess.js so every backend
 * behaves identically.
 */

export function sideOfPlayer(game: GameState, playerId: string): PlayerSide | null {
  if (game.creator === playerId) return "white";
  if (game.opponent === playerId) return "black";
  return null;
}

function moveCommentaryText(
  side: PlayerSide,
  move: Move,
  after: { isCheckmate: boolean; inCheck: boolean },
): string {
  const sideName = side === "white" ? "White" : "Black";
  const capturedName = move.captured === "p" ? "pawn" : (move.captured ?? null);
  let text: string;
  if (move.san === "O-O" || move.san === "O-O-O") {
    text = `${sideName} castles ${
      move.san === "O-O" ? "kingside" : "queenside"
    }, tucking the king behind a wall of pawns (${move.san}).`;
  } else if (move.promotion) {
    text = `Promotion! ${sideName} plays ${move.san}.`;
  } else if (capturedName) {
    text = `${sideName} captures a ${capturedName} with ${move.san}.`;
  } else {
    text = `${sideName} plays ${move.san}.`;
  }
  if (after.isCheckmate) {
    text += " That is checkmate — the game is over!";
  } else if (after.inCheck) {
    text += " This move puts the opponent in check.";
  }
  return text;
}

export type ActionResult =
  | { ok: true; game: GameState }
  | { ok: false; error: string };

/** Let a player join an open game as Black. */
export function joinPlayerToGame(game: GameState, playerId: string): ActionResult {
  if (game.status !== "waiting") {
    return { ok: false, error: "This game is not waiting for players" };
  }
  if (game.creator === playerId) {
    return { ok: false, error: "You cannot join your own game" };
  }
  if (game.opponent) {
    return { ok: false, error: "This game already has two players" };
  }
  return { ok: true, game: { ...game, opponent: playerId, status: "active" } };
}

/** Validate and apply a move for one of the players. */
export function applyMoveToGame(
  game: GameState,
  playerId: string,
  from: string,
  to: string,
  promotion?: string,
): ActionResult {
  if (game.status !== "active") {
    return { ok: false, error: "The game is not active" };
  }
  const mySide = sideOfPlayer(game, playerId);
  if (!mySide) {
    return { ok: false, error: "You are not a player in this game" };
  }

  const info = describePosition(game.fen);
  const expected = info.turn === "w" ? "white" : "black";
  if (mySide !== expected) {
    return { ok: false, error: "It is not your turn" };
  }

  const outcome = applyChessMove(game.fen, from, to, promotion);
  if (!outcome.ok || !outcome.move || !outcome.fen) {
    return { ok: false, error: outcome.error ?? "Illegal move" };
  }

  const after = describePosition(outcome.fen);
  const entry: CommentaryEntry = {
    move: outcome.move.san,
    side: mySide,
    text: moveCommentaryText(mySide, outcome.move, after),
    source: "chain",
  };

  // Playing a move cancels any pending draw offer (the game moved on).
  let status: GameStatus = "active";
  let winner = "";
  if (after.isCheckmate) {
    status = "checkmate";
    winner = playerId;
  } else if (after.isStalemate) {
    status = "stalemate";
  } else if (after.isDraw) {
    status = "draw";
  }

  return {
    ok: true,
    game: {
      ...game,
      fen: outcome.fen,
      status,
      winner,
      drawOffer: undefined,
      moves: [
        ...game.moves,
        {
          number: game.moves.length + 1,
          side: mySide,
          from,
          to,
          promotion: promotion ?? "",
          san: outcome.move.san,
        },
      ],
      commentary: [...game.commentary, entry],
    },
  };
}

/** Offer a draw to the opponent. The offer stays pending until accepted,
 *  declined, or the next move is played. */
export function offerDrawToGame(game: GameState, playerId: string): ActionResult {
  if (game.status !== "active") {
    return { ok: false, error: "The game is not active" };
  }
  const mySide = sideOfPlayer(game, playerId);
  if (!mySide) {
    return { ok: false, error: "You are not a player in this game" };
  }
  if (game.drawOffer?.by === playerId) {
    return { ok: false, error: "You already offered a draw — waiting for your opponent" };
  }
  return {
    ok: true,
    game: {
      ...game,
      drawOffer: { by: playerId, at: Date.now() },
    },
  };
}

/** Accept (ends the game in a draw) or decline the opponent's draw offer. */
export function respondToDrawOffer(
  game: GameState,
  playerId: string,
  accept: boolean,
): ActionResult {
  if (game.status !== "active") {
    return { ok: false, error: "The game is not active" };
  }
  if (!game.drawOffer) {
    return { ok: false, error: "There is no pending draw offer" };
  }
  const mySide = sideOfPlayer(game, playerId);
  if (!mySide) {
    return { ok: false, error: "You are not a player in this game" };
  }
  if (game.drawOffer.by === playerId) {
    return { ok: false, error: "You cannot accept your own draw offer" };
  }
  if (accept) {
    return {
      ok: true,
      game: {
        ...game,
        status: "draw",
        winner: "",
        drawOffer: undefined,
        commentary: [
          ...game.commentary,
          {
            move: "",
            side: mySide,
            text: "The players agreed to a draw.",
            source: "chain",
          },
        ],
      },
    };
  }
  return {
    ok: true,
    game: {
      ...game,
      drawOffer: undefined,
      commentary: [
        ...game.commentary,
        {
          move: "",
          side: mySide,
          text: "The draw offer was declined; play continues.",
          source: "chain",
        },
      ],
    },
  };
}

/**
 * Abort a game before any move has been played. No winner, no rating
 * impact — the game simply never happened. Both players can abort a
 * waiting or freshly-started match; once the first move is played the
 * only way out is resignation.
 */
export function abortGame(game: GameState, playerId: string): ActionResult {
  if (game.status !== "waiting" && game.status !== "active") {
    return { ok: false, error: "The game is already over" };
  }
  const mySide = sideOfPlayer(game, playerId);
  if (!mySide) {
    return { ok: false, error: "You are not a player in this game" };
  }
  if (game.moves.length > 0) {
    return { ok: false, error: "The game has started — resign instead of aborting" };
  }
  return {
    ok: true,
    game: {
      ...game,
      status: "aborted",
      winner: "",
      drawOffer: undefined,
      commentary: [
        ...game.commentary,
        {
          move: "",
          side: mySide,
          text: "The game was aborted before any moves were played.",
          source: "chain",
        },
      ],
    },
  };
}

/** Resign the game as one of the players (the other side wins). */
export function resignPlayerFromGame(game: GameState, playerId: string): ActionResult {
  if (game.status !== "active") {
    return { ok: false, error: "The game is not active" };
  }
  const mySide = sideOfPlayer(game, playerId);
  if (!mySide) {
    return { ok: false, error: "You are not a player in this game" };
  }
  const next: GameState = {
    ...game,
    status: "resigned",
    winner: mySide === "white" ? game.opponent : game.creator,
    commentary: [
      ...game.commentary,
      {
        move: "",
        side: mySide,
        text: `${mySide === "white" ? "White" : "Black"} resigned the game.`,
        source: "chain",
      },
    ],
  };
  return { ok: true, game: next };
}
