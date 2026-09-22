import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import {
  claimOperatorSeat,
  isAdminPlayer,
  operatorPlayerId,
  passcodeIsSet,
  passcodeSessionValid,
  setPasscode,
  usernameForPlayer,
  verifyPasscode,
} from "@/lib/server/admin";
import {
  markSupportRead,
  replyToSupportMessage,
  sendBroadcast,
  supportInbox,
} from "@/lib/server/messages";

export const runtime = "nodejs";

/**
 * Admin messaging + dashboard passcode.
 *
 * POST actions:
 *   passcode-status  → is a code set? (open — just a boolean, drives the UI)
 *   passcode-set     → first-time set + confirm. While NO code exists and the
 *                      operator seat is unclaimed, the first signed-in
 *                      registered account to complete setup CLAIMS the seat
 *                      (bootstrap — the env allowlist is otherwise unset on
 *                      hosting). Once a code exists, only a recognized admin
 *                      may touch this action.
 *   passcode-verify  → unlock a 30-minute dashboard session
 *   support-inbox    → everything players sent to ChainMate
 *   reply            → official-account DM to one player
 *   broadcast        → official-account message to EVERY registered player
 */

interface AdminMessageBody {
  playerId?: string;
  action?:
    | "passcode-status"
    | "passcode-set"
    | "passcode-verify"
    | "support-inbox"
    | "support-mark-read"
    | "reply"
    | "broadcast";
  code?: string;
  codeConfirm?: string;
  passcodeToken?: string;
  toPlayerId?: string;
  body?: string;
}

async function adminIdentity(req: NextRequest, claimed: string) {
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) return acting;
  if (!(await isAdminPlayer(acting.playerId))) {
    return { ok: false as const, error: "Not found", status: 404 };
  }
  return { ok: true as const, playerId: acting.playerId };
}

export async function POST(req: NextRequest) {
  let body: AdminMessageBody;
  try {
    body = (await req.json()) as AdminMessageBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const fromQuery = req.nextUrl.searchParams.get("playerId")?.trim() ?? "";

  // passcode-status is intentionally open: the setup screen must be reachable
  // before any admin exists, and a true/false boolean leaks nothing.
  if (body.action === "passcode-status") {
    return NextResponse.json({ set: await passcodeIsSet() });
  }

  // passcode-set bootstrap: while no code exists AND nobody holds the seat,
  // the first signed-in REGISTERED account (guests excluded) completes setup
  // and claims the operator console for good.
  if (body.action === "passcode-set" && !(await passcodeIsSet()) && !(await operatorPlayerId())) {
    const acting = await resolveActingPlayer(req, claimed || fromQuery);
    if (!acting.ok) {
      return NextResponse.json({ error: acting.error }, { status: acting.status });
    }
    const username = await usernameForPlayer(acting.playerId);
    if (!username) {
      return NextResponse.json(
        { error: "Sign in with a registered account to claim the console" },
        { status: 403 },
      );
    }
    const res = await setPasscode((body.code ?? "").trim(), (body.codeConfirm ?? "").trim());
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
    await claimOperatorSeat(acting.playerId);
    return NextResponse.json({ ok: true, token: res.token, claimed: true });
  }

  const identity = await adminIdentity(req, claimed || fromQuery);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }

  try {
    if (body.action === "passcode-set") {
      const res = await setPasscode((body.code ?? "").trim(), (body.codeConfirm ?? "").trim());
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      return NextResponse.json({ ok: true, token: res.token });
    }
    if (body.action === "passcode-verify") {
      const res = await verifyPasscode((body.code ?? "").trim());
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 403 });
      return NextResponse.json({ ok: true, token: res.token });
    }

    // Everything below requires BOTH identity and a live passcode session.
    if (!(await passcodeSessionValid(body.passcodeToken ?? null))) {
      return NextResponse.json(
        { error: "Dashboard locked: enter the passcode again" },
        { status: 423 },
      );
    }

    if (body.action === "support-inbox") {
      const res = await supportInbox(identity.playerId);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 403 });
      return NextResponse.json({ messages: res.messages });
    }
    if (body.action === "reply") {
      const to = (body.toPlayerId ?? "").trim();
      if (!to) return NextResponse.json({ error: "toPlayerId is required" }, { status: 400 });
      const res = await replyToSupportMessage(identity.playerId, to, body.body ?? "");
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "support-mark-read") {
      const res = await markSupportRead(identity.playerId);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 403 });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "broadcast") {
      const to = (body.toPlayerId ?? "").trim() || undefined;
      const res = await sendBroadcast(identity.playerId, body.body ?? "", to);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      return NextResponse.json({ ok: true, recipients: res.recipients });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Action failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
