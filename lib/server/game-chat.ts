// Server-only module — never import from client components.

/**
 * In-game chat: two players talking inside one ChainMate game.
 *
 * Messages live ON the game document (the same store every move already
 * persists through), capped to the newest 200. Only the two participants can
 * read or write — spectators get nothing, so nobody can lurk on a private
 * conversation. Clients poll with the game they already poll; no extra
 * channel is needed. Abusive chats can be reviewed by reading the same
 * document the admin tools already reach.
 */

import { getHostedGame, writeHostedGameWithChat } from "@/lib/server/hosted";
import { isGameOver } from "@/lib/types";
import { usernameForPlayer } from "@/lib/server/admin";
import { guestDisplayName } from "@/lib/identity";

const CHAT_LIMIT = 200;
const MAX_LEN = 500;

export interface ChatMessage {
  id: string;
  /** Sending player id — always one of the game's two participants. */
  fromPlayerId: string;
  fromName: string;
  body: string;
  sentAt: number;
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `c_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** The two player ids allowed to use this game's chat (null when unset). */
function participantsOf(game: {
  creator: string;
  opponent?: string | null;
}): [string, string] | null {
  const black = game.opponent ?? "";
  if (!game.creator || !black) return null;
  return [game.creator, black];
}

export async function readGameChat(
  gameId: string,
  readerId: string,
): Promise<{ ok: true; messages: ChatMessage[] } | { ok: false; error: string }> {
  const game = await getHostedGame(gameId);
  if (!game) return { ok: false, error: "Game not found" };
  const participants = participantsOf(game);
  if (!participants) return { ok: true, messages: [] };
  if (readerId !== participants[0] && readerId !== participants[1]) {
    // Spectators and strangers get nothing — not an error, just silence.
    return { ok: true, messages: [] };
  }
  const messages = (game as { chat?: ChatMessage[] }).chat ?? [];
  return { ok: true, messages };
}

export async function sendGameChat(
  gameId: string,
  senderId: string,
  body: string,
): Promise<{ ok: true; message: ChatMessage } | { ok: false; error: string }> {
  const text = (body ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  if (!text) return { ok: false, error: "Message is empty" };

  const existing = await getHostedGame(gameId);
  if (existing && isGameOver(existing.status)) {
    return { ok: false, error: "This game is over" };
  }

  const game = await getHostedGame(gameId);
  if (!game) return { ok: false, error: "Game not found" };
  const participants = participantsOf(game);
  if (!participants) return { ok: false, error: "This game has no opponent yet" };
  if (senderId !== participants[0] && senderId !== participants[1]) {
    return { ok: false, error: "Only the two players can chat in this game" };
  }

  // Chat names a PERSON: the recorded username verbatim for real players,
  // the plain word "Guest" for machine-minted artifacts, empty when nothing
  // resolves (the client renders its blank-name placeholder).
  const fromName = guestDisplayName(await usernameForPlayer(senderId));
  const message: ChatMessage = {
    id: newId(),
    fromPlayerId: senderId,
    fromName,
    body: text,
    sentAt: Date.now(),
  };

  const withChat = game as typeof game & { chat?: ChatMessage[] };
  withChat.chat = [...(withChat.chat ?? []), message].slice(-CHAT_LIMIT);
  await writeHostedGameWithChat(withChat);
  return { ok: true, message };
}
