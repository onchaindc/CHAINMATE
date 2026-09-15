import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { issueWalletChallenge, type NimiqChallenge } from "@/lib/server/nimiq/service";
import { isPlausibleNimiqAddress, type NimiqNetworkName } from "@/lib/nimiq/config";

export const runtime = "nodejs";

interface ChallengeBody {
  playerId?: string;
  /** Optional override; defaults to the deployment's configured network. */
  network?: string;
  /** Optional treasury sanity input — unused in 1B, rejected if present. */
  address?: string;
}

/**
 * POST /api/nimiq/challenge — issue a single-use wallet-link challenge.
 *
 * Authenticated through resolveActingPlayer exactly like every other ChainMate
 * write: a session token decides the player when present; a bare claim is only
 * honoured for guests. The nonce/message are server-generated and stored; the
 * client receives the exact string to hand to the wallet.
 */
export async function POST(req: NextRequest) {
  let body: ChallengeBody;
  try {
    body = (await req.json().catch(() => ({}))) as ChallengeBody;
  } catch {
    body = {};
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  // An optional address is accepted for UX (the client can prefill) but is
  // never authoritative: verification re-derives it from the public key. A
  // malformed one is rejected early so the user gets a useful error.
  if (body.address && !isPlausibleNimiqAddress(body.address)) {
    return NextResponse.json({ error: "That doesn't look like a Nimiq address" }, { status: 400 });
  }

  let network: NimiqNetworkName | undefined;
  if (body.network) {
    const normalized = body.network.trim().toLowerCase();
    if (normalized !== "main" && normalized !== "test") {
      return NextResponse.json(
        { error: "network must be \"main\" or \"test\"" },
        { status: 400 },
      );
    }
    network = normalized;
  }

  try {
    const challenge: NimiqChallenge = await issueWalletChallenge(acting.playerId, network);
    return NextResponse.json({ challenge });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to issue challenge";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
