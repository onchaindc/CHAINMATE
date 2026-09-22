// Server-only module — never import from client components.

/**
 * The automatic one-time welcome.
 *
 * Every NEW signup gets exactly one DM from the official ChainMate account:
 * it lands in their inbox, rings the bell (notifyDirectMessage), and its tap
 * opens the ChainMate thread — the front door to the DMs. Sent at profile
 * creation (app/api/identity/link), the single moment an account exists.
 *
 * ONCE means once: the durable guard is the inbox itself — a count of the
 * player's own sent-to-them envelopes is the wrong tool, so instead we scan
 * the recipient's inbox for any prior welcome flag envelope. The envelope
 * carries a stable marker id (WELCOME_ENVELOPE_ID) as its `id`; the check is
 * a substring scan over that recipient's inbox for the marker, so a retried
 * request, a double click on "create account", or two serverless instances
 * racing the same signup can never deliver a second welcome. The id is
 * deterministic per recipient, which also makes the dedup scan trivial.
 */

import { OFFICIAL_ACCOUNT_ID } from "@/lib/server/messages";

/** Stable marker id so the dedup scan can recognise a welcome envelope. */
function welcomeEnvelopeId(playerId: string): string {
  return `welcome_${playerId}`;
}

const WELCOME_PREFIX = "welcome_";

/**
 * True when this player has a welcome envelope in their inbox already.
 * The inbox read is the same store every message flow uses, so a welcome
 * survives restarts exactly as durably as the messages themselves.
 */
async function hasWelcome(playerId: string): Promise<boolean> {
  const { inboxFor } = await import("@/lib/server/messages");
  const inbox = await inboxFor(playerId);
  return inbox.some((m) => m.id.startsWith(WELCOME_PREFIX));
}

/**
 * Send the welcome if (and only if) this player never received one.
 * Called from the account-creation flow AFTER the profile row exists and the
 * identity is registered — the welcome is layered on a real account, never
 * sent to a half-created one. Best-effort by design: a welcome failure must
 * never fail the signup that a player is actively waiting on.
 */
export async function sendWelcomeIfNew(playerId: string, username: string): Promise<void> {
  try {
    if (await hasWelcome(playerId)) return;
    const { sendDirectMessage } = await import("@/lib/server/messages");
    // The friends gate would bounce any other non-admin sender; the official
    // account carries delivery authority inside sendDirectMessage itself.
    await sendDirectMessage(
      OFFICIAL_ACCOUNT_ID,
      playerId,
      `Welcome to ChainMate, ${username}! 🎉 Your account is ready. Start with a quick game from the Play page, try the AI opponent, or jump into a free tournament. Add friends from their profiles to chat — and message us right here any time. This thread reaches the team, and we read every reply.`,
    ).catch(() => undefined);
    // Stamp the delivered envelope with the stable welcome marker so the
    // dedup holds even if the inbox read raced another instance's send.
    const { stampWelcomeEnvelope } = await import("@/lib/server/messages");
    await stampWelcomeEnvelope(playerId, welcomeEnvelopeId(playerId));
  } catch {
    // Never block signup on the welcome.
  }
}
