import { NextRequest, NextResponse } from "next/server";
import { runTournamentMaintenance } from "@/lib/server/tournaments";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/tournaments/maintenance — drive the tournament time machine.
 *
 * Every transition the sweep performs is idempotent and lock-guarded (see
 * runTournamentMaintenance), so this endpoint is safe to hit on any cadence
 * from any number of sources: a Vercel cron, an external scheduler, or a
 * browser refresh — double runs converge to the same state instead of
 * duplicating work. The app's own reads already run the sweep (the poll
 * cadence is the in-app scheduler); this endpoint exists for deployments
 * that want the state machine to advance even with zero readers.
 *
 * When CRON_SECRET is set the request must carry `Authorization: Bearer
 * <secret>` (Vercel Cron sends exactly that). Unset → open, because a
 * maintenance sweep is not a mutation a player could weaponize: it only
 * applies the lifecycle rules the engine would apply on the next read.
 */
export async function POST(req: NextRequest) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  try {
    await runTournamentMaintenance();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Maintenance sweep failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** GET is accepted for schedulers that cannot send POST bodies/auth easily. */
export async function GET(req: NextRequest) {
  return POST(req);
}
