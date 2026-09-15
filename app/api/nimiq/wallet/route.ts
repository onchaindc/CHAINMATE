import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  NimiqLinkError,
  getLinkedWallet,
  linkWallet,
  unlinkWallet,
  type LinkWalletInput,
} from "@/lib/server/nimiq/service";
import type { NimiqNetworkName } from "@/lib/nimiq/config";

export const runtime = "nodejs";

/** Public shape — never exposes the public key or any challenge material. */
interface WalletResponse {
  wallet: {
    address: string;
    network: string;
    linkedAt: number;
  } | null;
}

interface WalletBody {
  playerId?: string;
  nonce?: string;
  signature?: string;
  publicKey?: string;
  /** Display address from the wallet UI; verified, never trusted. */
  address?: string;
  network?: string;
  replace?: boolean;
}

function normalizeNetwork(value: string | undefined): NimiqNetworkName | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "main" || normalized === "test" ? normalized : undefined;
}

/**
 * GET /api/nimiq/wallet — the authenticated player's linked wallet (or null).
 */
export async function GET(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  try {
    const wallet = await getLinkedWallet(acting.playerId);
    return NextResponse.json({ wallet } satisfies WalletResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load wallet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/nimiq/wallet — verify a signed challenge and bind the wallet.
 * Every rejection path in the Phase 1B brief maps to a 4xx with a clear
 * message; the server never trusts the client's address claim.
 */
export async function POST(req: NextRequest) {
  let body: WalletBody;
  try {
    body = (await req.json()) as WalletBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  if (!body.nonce || !body.signature || !body.publicKey) {
    return NextResponse.json(
      { error: "nonce, signature and publicKey are required" },
      { status: 400 },
    );
  }

  const input: LinkWalletInput = {
    playerId: acting.playerId,
    nonce: body.nonce,
    signature: body.signature,
    publicKey: body.publicKey,
    address: body.address,
    network: normalizeNetwork(body.network),
    replace: body.replace === true,
  };

  try {
    const wallet = await linkWallet(input);
    return NextResponse.json({ wallet } satisfies WalletResponse);
  } catch (err) {
    if (err instanceof NimiqLinkError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to link wallet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/nimiq/wallet — unlink the player's wallet. Idempotent.
 */
export async function DELETE(req: NextRequest) {
  const claimed = req.nextUrl.searchParams.get("playerId") ?? "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  try {
    await unlinkWallet(acting.playerId);
    return NextResponse.json({ wallet: null } satisfies WalletResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unlink wallet";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
