"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, CheckCircle2, Loader2, ShieldAlert, ShieldX, Trash2, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";

/**
 * ChainMate admin dashboard — penal actions.
 *
 * Reachable only by the operator: the /api/admin routes fail closed with a
 * 404 for anyone else, and this page mirrors that (a non-admin sees a bare
 * "not found" panel with no hint of what lives here). For now the panel is
 * restrictions: ban (with reason) and unban. The anti-cheat detector the
 * operator plans lands later; these doors are what its findings will act on.
 */

interface BanRecord {
  playerId: string;
  reason: string;
  bannedAt: number;
  bannedBy: string;
}

interface BansPayload {
  bans: BanRecord[];
  names: Record<string, string>;
}

interface AdminTournamentRow {
  id: string;
  name: string;
  status: string;
  format: string;
  hostName: string | null;
  entries: number;
  paidEntries: number;
  prizePoolNim: string | null;
  entryFeeNim: string | null;
}

interface TournamentsPayload {
  tournaments: AdminTournamentRow[];
}

async function adminApi<T>(
  path: string,
  playerId: string,
  init?: RequestInit,
): Promise<T> {
  const token = getIdentityToken();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}playerId=${encodeURIComponent(playerId)}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export default function AdminPage() {
  const identity = useIdentity();
  const playerId = identity.playerId;

  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [bans, setBans] = useState<BanRecord[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [tournaments, setTournaments] = useState<AdminTournamentRow[] | null>(null);
  const [target, setTarget] =useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingBan, setPendingBan] = useState<string | null>(null);
  const [pendingTourAction, setPendingTourAction] = useState<{
    row: AdminTournamentRow;
    action: "cancel" | "complete" | "delete";
  } | null>(null);

  const load = useCallback(async () => {
    if (!playerId) return;
    try {
      const data = await adminApi<BansPayload>("/api/admin/bans", playerId);
      setBans(data.bans);
      setNames(data.names);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bans");
      setBans((prev) => prev ?? []);
    }
    try {
      const data = await adminApi<TournamentsPayload>("/api/admin/tournaments", playerId);
      setTournaments(data.tournaments);
    } catch {
      setTournaments((prev) => prev ?? []);
    }
  }, [playerId]);

  useEffect(() => {
    if (identity.status === "loading" || !playerId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await adminApi<{ admin: boolean }>("/api/admin/whoami", playerId);
        if (!cancelled) setIsAdmin(data.admin);
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
      if (!cancelled) void load();
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.status, playerId, load]);

  const act = async (action: "ban" | "unban", targetPlayerId: string, banReason?: string) => {
    if (!targetPlayerId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await adminApi("/api/admin/bans", playerId, {
        method: "POST",
        body: JSON.stringify({ action, targetPlayerId, reason: banReason ?? "" }),
      });
      setNotice(
        action === "ban"
          ? "Account restricted."
          : "Restriction lifted.",
      );
      setTarget("");
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const tourAction = async (tournamentId: string, action: "cancel" | "complete" | "delete") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await adminApi<{ message: string }>("/api/admin/tournaments", playerId, {
        method: "POST",
        body: JSON.stringify({ action, tournamentId }),
      });
      setNotice(data.message ?? "Done.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  if (identity.status === "loading" || isAdmin === null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <Panel>
          <EmptyState
            icon={ShieldX}
            title="Page not found"
            description="The address may be wrong, or the page may have been removed."
            action={{ href: "/", label: "Back home" }}
          />
        </Panel>
      </div>
    );
  }

  const fmt = (ts: number) => new Date(ts).toLocaleString();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <BackLink href="/" className="mb-4">
        Back to home
      </BackLink>
      <PageHeader
        eyebrow="Operator"
        title="Admin dashboard"
        description="Restrict accounts for cheating or abuse. Banned players cannot join or host tournaments or open paid seats until lifted."
      />

      <div className="animate-fade-in-up mt-8 grid gap-6">
        <Panel>
          <div className="space-y-3 p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
              Restrict an account
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              <label className="block">
                <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Player id or username
                </span>
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="acct_… or username"
                  className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-primary/50"
                />
              </label>
              <label className="block">
                <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Reason (shown to the player)
                </span>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Suspected engine use in tournament …"
                  className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
                />
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="destructive"
                size="sm"
                disabled={busy || target.trim().length < 3}
                onClick={() => setPendingBan(target.trim())}
              >
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Ban aria-hidden />}
                Restrict account
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || target.trim().length < 3}
                onClick={() => void act("unban", target.trim())}
              >
                <Undo2 aria-hidden />
                Lift restriction
              </Button>
            </div>
            {notice && (
              <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground/90">
                {notice}
              </p>
            )}
          </div>
        </Panel>

        <section>
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Active restrictions
          </p>
          <Panel className="mt-3">
            {bans === null ? (
              <LoadingRows rows={3} />
            ) : bans.length === 0 ? (
              <EmptyState
                icon={ShieldAlert}
                title="No restricted accounts"
                description="Everyone is in good standing."
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-border/50">
                {bans.map((b) => (
                  <li key={b.playerId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm">
                        {names[b.playerId] ?? b.playerId}
                      </p>
                      <p className="mt-0.5 truncate text-2xs text-muted-foreground">
                        {b.reason} · {fmt(b.bannedAt)} · by {names[b.bannedBy] ?? b.bannedBy}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void act("unban", b.playerId)}
                    >
                      <Undo2 className="h-3.5 w-3.5" aria-hidden />
                      Lift
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        <section>
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Tournaments
          </p>
          <Panel className="mt-3">
            {tournaments === null ? (
              <LoadingRows rows={3} />
            ) : tournaments.length === 0 ? (
              <EmptyState
                icon={ShieldAlert}
                title="No tournaments yet"
                description="Every hosted event appears here with its entries and prize pool."
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-border/50">
                {tournaments.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="mt-0.5 truncate text-2xs text-muted-foreground">
                        {t.status} · {t.format} · host {t.hostName ?? t.id} · {t.entries} player{t.entries === 1 ? "" : "s"}
                        {t.prizePoolNim ? ` · pool ${t.prizePoolNim} NIM (${t.paidEntries} paid @ ${t.entryFeeNim})` : " · free"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {t.status === "in_progress" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPendingTourAction({ row: t, action: "complete" })}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                          Force finish
                        </Button>
                      )}
                      {t.status !== "completed" && t.status !== "cancelled" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPendingTourAction({ row: t, action: "cancel" })}
                        >
                          <XCircle className="h-3.5 w-3.5" aria-hidden />
                          Cancel
                        </Button>
                      )}
                      {t.status !== "in_progress" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPendingTourAction({ row: t, action: "delete" })}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          Delete
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      </div>

      {error && <ErrorNote message={error} className="mt-4" />}

      <ConfirmDialog
        open={pendingBan !== null}
        title={`Restrict ${pendingBan ?? ""}?`}
        confirmLabel="Restrict account"
        destructive
        busy={busy}
        onCancel={() => setPendingBan(null)}
        onConfirm={() => {
          const t = pendingBan;
          setPendingBan(null);
          if (t) void act("ban", t, reason.trim());
        }}
      >
        They will be shut out of hosting, joining and paying until you lift the
        restriction.
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingTourAction !== null}
        title={
          pendingTourAction
            ? `${pendingTourAction.action === "cancel" ? "Cancel" : pendingTourAction.action === "complete" ? "Force finish" : "Delete"} "${pendingTourAction.row.name}"?`
            : ""
        }
        confirmLabel={
          pendingTourAction
            ? pendingTourAction.action === "cancel"
              ? "Cancel tournament"
              : pendingTourAction.action === "complete"
                ? "Force finish"
                : "Delete tournament"
            : ""
        }
        destructive={pendingTourAction?.action !== "complete"}
        busy={busy}
        onCancel={() => setPendingTourAction(null)}
        onConfirm={() => {
          const p = pendingTourAction;
          setPendingTourAction(null);
          if (p) void tourAction(p.row.id, p.action);
        }}
      >
        {pendingTourAction?.action === "cancel" &&
          "Registration and play stop now. If players already paid, the event is flagged for refunds and their entry fees are NOT refunded automatically."}
        {pendingTourAction?.action === "complete" &&
          "The event closes now and standings freeze at whatever has been played. Unfinished games count as unplayed. Prize payouts are planned from the final standings."}
        {pendingTourAction?.action === "delete" &&
          "The tournament is removed entirely. Deletion is refused while players have paid entries: resolve refunds first."}
      </ConfirmDialog>
    </div>
  );
}
