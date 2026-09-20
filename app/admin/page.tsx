"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Inbox,
  Loader2,
  Lock,
  LogOut,
  MessageSquare,
  Send,
  ShieldAlert,
  ShieldX,
  Trash2,
  Undo2,
  Users,
  Volume2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { StatTiles } from "@/components/profile/stat-tiles";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { formatNim } from "@/lib/nimiq/format";

/**
 * ChainMate admin dashboard.
 *
 * Gates: the 4-digit passcode (set once, confirmed, salted-hash stored)
 * opens a 30-minute session that re-locks on idle. The FIRST registered
 * account to complete setup claims the operator seat (bootstrap, so the
 * console works with no env configuration); after that, only the seat
 * holder (or an ADMIN_USERNAMES account) reaches the console at all.
 * Only inside a live session can the operator ban, unban, permanently
 * delete accounts, read the support inbox, reply as ChainMate, or
 * broadcast to every player at once.
 */

/**
 * One-click moderation warnings, sent from the per-account Message composer.
 * Placeholders: {name} (username or id). Ordered softest first.
 */
const WARNING_TEMPLATES: { label: string; text: string }[] = [
  {
    label: "Fair-play reminder",
    text: "Hi {name}. We received a report about possible engine assistance in one of your recent games. Please keep play fair; repeated violations lead to a restriction.",
  },
  {
    label: "Chat conduct warning",
    text: "Hi {name}. Your recent chat messages broke our community rules. This is a warning: further reports may lead to chat restrictions.",
  },
  {
    label: "Tournament conduct warning",
    text: "Hi {name}. Your conduct in a recent tournament drew complaints (stalling or premature exits). Please play your scheduled matches; repeated no-shows lead to removal from events.",
  },
  {
    label: "Final warning before restriction",
    text: "Hi {name}. This is a final warning. One more violation of the ChainMate rules and your account will be restricted. Reply here if you believe this was sent in error.",
  },
  {
    label: "Restriction notice",
    text: "Hi {name}. Your account has been restricted by the ChainMate team for breaking our rules. Restrictions are reviewed; reply here to appeal.",
  },
];

interface BanRecord {
  playerId: string;
  reason: string;
  bannedAt: number;
  bannedBy: string;
}

interface AdminAccount {
  playerId: string;
  username: string | null;
  rating: number | null;
  games: number;
  banned: boolean;
  banReason: string | null;
}

interface SupportMessage {
  id: string;
  fromPlayerId: string;
  fromName: string;
  body: string;
  sentAt: number;
  readAt: number | null;
}

interface AdminPayoutLine {
  playerId: string;
  playerName: string | null;
  payoutRank: number;
  shareBps: number;
  amountLuna: string;
  status: string;
  destinationAddress: string | null;
}

interface AdminRefundLine {
  playerId: string;
  playerName: string | null;
  amountLuna: string;
  status: string;
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
  payoutStatus: string;
  prizePreset: string | null;
  payouts: AdminPayoutLine[];
  refunds: AdminRefundLine[];
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

const SESSION_KEY = "chainmate:admin:passcode-session";

export default function AdminPage() {
  const identity = useIdentity();
  const playerId = identity.playerId;

  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [passcodeSet, setPasscodeSet] = useState<boolean | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Restore a still-live passcode session across reloads (the 30-minute
  // clock itself is enforced server-side).
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.sessionStorage.getItem(SESSION_KEY) : null;
    if (saved) setToken(saved);
  }, []);

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
      try {
        const data = await adminApi<{ set: boolean }>("/api/admin/messages", playerId, {
          method: "POST",
          body: JSON.stringify({ action: "passcode-status" }),
        });
        if (!cancelled) setPasscodeSet(data.set);
      } catch {
        if (!cancelled) setPasscodeSet(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.status, playerId]);

  const unlock = (t: string) => {
    setToken(t);
    try {
      window.sessionStorage.setItem(SESSION_KEY, t);
    } catch {
      // Private mode — the session just won't survive a reload.
    }
  };

  const relock = () => {
    setToken(null);
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  };

  if (identity.status === "loading" || isAdmin === null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-16">
        <Panel>
          <LoadingRows rows={4} />
        </Panel>
      </div>
    );
  }

  // Gate order matters: while no passcode exists the setup screen must be
  // reachable (first visitor claims the seat), so the admin check only
  // decides the outcome once a code is set.
  if (passcodeSet === false) {
    return <PasscodeSetup playerId={playerId} onSet={unlock} />;
  }

  if (isAdmin === false) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-16">
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

  if (passcodeSet === null || isAdmin === null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-16">
        <Panel>
          <LoadingRows rows={2} />
        </Panel>
      </div>
    );
  }

  if (!token) {
    return <PasscodeUnlock playerId={playerId} onUnlock={unlock} />;
  }

  return (
    <Dashboard
      playerId={playerId}
      passcodeToken={token}
      onLock={relock}
      onUnlock={unlock}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Passcode: first-time setup                                          */
/* ------------------------------------------------------------------ */

function PasscodeSetup({
  playerId,
  onSet,
}: {
  playerId: string;
  onSet: (token: string) => void;
}) {
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await adminApi<{ token: string }>("/api/admin/messages", playerId, {
        method: "POST",
        body: JSON.stringify({ action: "passcode-set", code, codeConfirm: confirm }),
      });
      onSet(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  const ready = /^[0-9]{4}$/.test(code) && code === confirm;

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-10 sm:py-16">
      <Panel className="p-5">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Lock className="h-4 w-4 text-primary" aria-hidden />
          Set your dashboard code
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Pick a 4-digit code for the admin console. You will be asked for it
          whenever the dashboard has been idle for 30 minutes.
        </p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="••••"
          className="mt-4 w-full rounded-md border border-border/70 bg-background px-3 py-2.5 text-center font-mono text-xl tracking-[0.5em] outline-none transition-colors focus:border-primary/50"
        />
        <input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={4}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="Confirm"
          className="mt-2 w-full rounded-md border border-border/70 bg-background px-3 py-2.5 text-center font-mono text-xl tracking-[0.5em] outline-none transition-colors focus:border-primary/50"
        />
        {code.length === 4 && confirm.length === 4 && code !== confirm && (
          <p className="mt-2 text-2xs text-destructive">The two codes do not match</p>
        )}
        {error && <ErrorNote message={error} className="mt-2" />}
        <Button className="mt-4 w-full" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Lock aria-hidden />}
          Set code and open dashboard
        </Button>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Passcode: unlock a locked console                                   */
/* ------------------------------------------------------------------ */

function PasscodeUnlock({
  playerId,
  onUnlock,
}: {
  playerId: string;
  onUnlock: (token: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await adminApi<{ token: string }>("/api/admin/messages", playerId, {
        method: "POST",
        body: JSON.stringify({ action: "passcode-verify", code }),
      });
      onUnlock(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unlock failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-10 sm:py-16">
      <Panel className="p-5">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Lock className="h-4 w-4 text-primary" aria-hidden />
          Dashboard locked
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Enter your 4-digit code. The console re-locks after 30 minutes idle.
        </p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && code.length === 4 && void submit()}
          placeholder="••••"
          className="mt-4 w-full rounded-md border border-border/70 bg-background px-3 py-2.5 text-center font-mono text-xl tracking-[0.5em] outline-none transition-colors focus:border-primary/50"
        />
        {error && <ErrorNote message={error} className="mt-2" />}
        <Button
          className="mt-4 w-full"
          disabled={busy || code.length !== 4}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Lock aria-hidden />}
          Unlock
        </Button>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The dashboard itself                                                */
/* ------------------------------------------------------------------ */

function Dashboard({
  playerId,
  passcodeToken,
  onLock,
  /** Re-open a session without leaving the page when the server says the
      dashboard locked (idle expiry, or a session lost between instances). */
  onUnlock,
}: {
  playerId: string;
  passcodeToken: string;
  onLock: () => void;
  onUnlock: (token: string) => void;
}) {
  const [bans, setBans] = useState<BanRecord[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [support, setSupport] = useState<SupportMessage[] | null>(null);
  const [tournaments, setTournaments] = useState<AdminTournamentRow[] | null>(null);

  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [broadcastText, setBroadcastText] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingBan, setPendingBan] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminAccount | null>(null);
  const [pendingBroadcast, setPendingBroadcast] = useState<"all" | "reply" | null>(null);
  const [messagingTarget, setMessagingTarget] = useState<string | null>(null);
  const [pendingTourAction, setPendingTourAction] = useState<{
    row: AdminTournamentRow;
    action: "cancel" | "complete" | "delete";
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const bansData = await adminApi<{ bans: BanRecord[]; names: Record<string, string> }>(
        "/api/admin/bans",
        playerId,
        { headers: { "X-Admin-Session": passcodeToken } },
      );
      setBans(bansData.bans);
      setNames((prev) => ({ ...prev, ...bansData.names }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bans");
      setBans((prev) => prev ?? []);
    }
    try {
      const accountsData = await adminApi<{ accounts: AdminAccount[]; totalUsers: number }>(
        "/api/admin/accounts",
        playerId,
        { headers: { "X-Admin-Session": passcodeToken } },
      );
      setAccounts(accountsData.accounts);
      setTotalUsers(accountsData.totalUsers);
    } catch (err) {
      // A swallowed error made the headline tile read a confident "0" when
      // the accounts endpoint was failing — indistinguishable from a genuinely
      // empty database. Surface it so the operator knows the count is unknown.
      setError(err instanceof Error ? err.message : "Failed to load accounts");
      setAccounts((prev) => prev ?? []);
    }
    try {
      const msgData = await adminApi<{ messages: SupportMessage[] }>("/api/admin/messages", playerId, {
        method: "POST",
        body: JSON.stringify({ action: "support-inbox", passcodeToken }),
      });
      setSupport(msgData.messages);
    } catch {
      setSupport((prev) => prev ?? []);
    }
    try {
      const tourData = await adminApi<{ tournaments: AdminTournamentRow[] }>(
        "/api/admin/tournaments",
        playerId,
        { headers: { "X-Admin-Session": passcodeToken } },
      );
      setTournaments(tourData.tournaments);
    } catch {
      setTournaments((prev) => prev ?? []);
    }
  }, [playerId, passcodeToken]);

  useEffect(() => {
    void load();
    /* Live dashboard: support messages, new accounts and tournament states
       refresh on their own, so the headline tiles count up the moment a
       player writes in. 15s keeps it current without hammering the API. */
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 4000);
  };

  const act = async (action: "ban" | "unban", targetPlayerId: string, banReason?: string) => {
    if (!targetPlayerId) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi("/api/admin/accounts", playerId, {
        method: "POST",
        body: JSON.stringify({ passcodeToken, action, targetPlayerId, reason: banReason ?? "" }),
      });
      flash(action === "ban" ? "Account restricted." : "Restriction lifted.");
      setTarget("");
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (account: AdminAccount) => {
    setBusy(true);
    setError(null);
    try {
      await adminApi("/api/admin/accounts", playerId, {
        method: "POST",
        body: JSON.stringify({ passcodeToken, action: "delete-account", targetPlayerId: account.playerId }),
      });
      flash(`Account ${account.username ?? account.playerId} permanently deleted.`);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const sendBroadcast = async () => {
    if (!broadcastText.trim()) return;
    setPendingBroadcast("all");
    setError(null);
    try {
      const data = await adminApi<{ recipients: number }>("/api/admin/messages", playerId, {
        method: "POST",
        body: JSON.stringify({ passcodeToken, action: "broadcast", body: broadcastText }),
      });
      flash(`Announcement sent to ${data.recipients} player${data.recipients === 1 ? "" : "s"}.`);
      setBroadcastText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setPendingBroadcast(null);
    }
  };

  const sendReply = async (toPlayerId: string) => {
    const text = (replyDrafts[toPlayerId] ?? "").trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi("/api/admin/messages", playerId, {
        method: "POST",
        body: JSON.stringify({ passcodeToken, action: "reply", toPlayerId, body: text }),
      });
      flash(`Reply sent to ${names[toPlayerId] ?? "player"}.`);
      setReplyDrafts((prev) => ({ ...prev, [toPlayerId]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setBusy(false);
    }
  };

  const tourAction = async (tournamentId: string, action: "cancel" | "complete" | "delete") => {
    setBusy(true);
    setError(null);
    try {
      const data = await adminApi<{ message: string }>("/api/admin/tournaments", playerId, {
        method: "POST",
        body: JSON.stringify({ action, tournamentId }),
      });
      flash(data.message ?? "Done.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const fmt = (ts: number) => new Date(ts).toLocaleString();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-16">
      <BackLink href="/" className="mb-4">
        Back to home
      </BackLink>
      <PageHeader
        eyebrow="Operator"
        title="Admin dashboard"
        description="Accounts, restrictions, support and official announcements. Every action below is permanent where it says so."
        actions={
          <Button variant="ghost" size="sm" onClick={onLock}>
            <LogOut aria-hidden />
            Lock now
          </Button>
        }
      />

      {/* Headline stat. "…" until the first successful load — a failed or
          still-loading request must not read as a confident zero. */}
      <StatTiles
        layout="three"
        className="animate-fade-in-up mt-6"
        tiles={[
          { label: "Total users", value: totalUsers === null ? "…" : String(totalUsers) },
          {
            label: "Active restrictions",
            value: bans === null ? "…" : String(bans.length),
          },
          {
            label: "Support messages",
            value:
              support === null
                ? "…"
                : String(support.filter((m) => m.readAt === null).length),
          },
        ]}
      />

      {/* The lock message has its own slot: it means "re-enter your code",
          which is actionable, not a load failure. Anything else the periodic
          refresh surfaces is an error, and shows as one. The dashboard
          content HIDES while locked — rendering the unlock card inside the
          rendered page stacked both on top of each other (the "leaking
          over themselves" screenshot). */}
      {error && error.includes("Dashboard locked") ? (
        <div className="mt-4">
          <PasscodeUnlock playerId={playerId} onUnlock={onUnlock} />
        </div>
      ) : (
        <>
          {error && <ErrorNote message={error} className="mt-4" />}

      {notice && (
        <p className="animate-fade-in-up mt-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground/90">
          {notice}
        </p>
      )}

      <div className="mt-6 grid gap-6">
        {/* ---------- Restrict / unban ---------- */}
        <Panel>
          <div className="space-y-3 p-4 sm:p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
              Restrict an account
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block min-w-0">
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
              <label className="block min-w-0">
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
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <Button
                variant="destructive"
                size="sm"
                className="w-full sm:w-auto"
                disabled={busy || target.trim().length < 3}
                onClick={() => setPendingBan(target.trim())}
              >
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Ban aria-hidden />}
                Restrict account
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                disabled={busy || target.trim().length < 3}
                onClick={() => void act("unban", target.trim())}
              >
                <Undo2 aria-hidden />
                Lift restriction
              </Button>
            </div>
          </div>
        </Panel>

        {/* ---------- Accounts ---------- */}
        <section>
          <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden />
            Accounts ({accounts?.length ?? "…"})
          </p>
          <Panel className="mt-3">
            {accounts === null ? (
              <LoadingRows rows={3} />
            ) : accounts.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No registered accounts yet"
                description="Every sign-up appears here with rating, games and restriction state."
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-border/50">
                {accounts.map((a) => (
                  <li
                    key={a.playerId}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        {a.username ?? a.playerId}
                        {a.banned && (
                          <span className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 py-px text-2xs font-semibold uppercase tracking-wider text-destructive">
                            Restricted
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
                        {a.rating ?? "Unrated"} rating · {a.games} games
                        {a.banned && a.banReason ? ` · ${a.banReason}` : ""}
                      </p>
                    </div>
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setMessagingTarget(
                            messagingTarget === a.playerId ? null : a.playerId,
                          )
                        }
                        aria-expanded={messagingTarget === a.playerId}
                      >
                        <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                        Message
                      </Button>
                      {a.banned ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void act("unban", a.playerId)}
                        >
                          <Undo2 className="h-3.5 w-3.5" aria-hidden />
                          Lift
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setPendingBan(a.username ?? a.playerId)}
                        >
                          <Ban className="h-3.5 w-3.5" aria-hidden />
                          Restrict
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        disabled={busy}
                        onClick={() => setPendingDelete(a)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        Delete
                      </Button>
                    </div>
                    {messagingTarget === a.playerId && (
                      <div className="flex w-full flex-col gap-2">
                        {/* One-click warnings: pick one, it fills the composer
                            (editable before sending), so moderation is two
                            clicks instead of typing the same paragraphs. */}
                        <label className="flex items-center gap-2 text-2xs text-muted-foreground">
                          <span className="shrink-0 font-semibold uppercase tracking-wider">
                            Warnings
                          </span>
                          <select
                            value=""
                            onChange={(e) => {
                              const t = WARNING_TEMPLATES.find((w) => w.label === e.target.value);
                              if (!t) return;
                              setReplyDrafts((prev) => ({
                                ...prev,
                                [a.playerId]: t.text.replaceAll(
                                  "{name}",
                                  a.username ?? a.playerId,
                                ),
                              }));
                            }}
                            className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs outline-none"
                          >
                            <option value="">Choose a warning template…</option>
                            {WARNING_TEMPLATES.map((w) => (
                              <option key={w.label} value={w.label}>
                                {w.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <input
                            type="text"
                            value={replyDrafts[a.playerId] ?? ""}
                            onChange={(e) =>
                              setReplyDrafts((prev) => ({ ...prev, [a.playerId]: e.target.value }))
                            }
                            maxLength={2000}
                            placeholder={`Message ${a.username ?? a.playerId} as ChainMate…`}
                            className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
                          />
                          <Button
                            size="sm"
                            className="w-full sm:w-auto"
                            disabled={busy || !(replyDrafts[a.playerId] ?? "").trim()}
                            onClick={() => void sendReply(a.playerId)}
                          >
                            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                            Send
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        {/* ---------- Support inbox ---------- */}
        <section>
          <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Inbox className="h-3.5 w-3.5" aria-hidden />
            Support inbox
          </p>
          <Panel className="mt-3">
            {support === null ? (
              <LoadingRows rows={3} />
            ) : support.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="Nothing from players yet"
                description="Messages players send to ChainMate support land here."
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-border/50">
                {support.map((m) => (
                  <li key={m.id} className="px-4 py-3">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">{m.fromName}</span>
                      <span className="ml-auto shrink-0 font-normal text-2xs text-muted-foreground">
                        {fmt(m.sentAt)}
                      </span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
                      {m.body}
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        type="text"
                        value={replyDrafts[m.fromPlayerId] ?? ""}
                        onChange={(e) =>
                          setReplyDrafts((prev) => ({ ...prev, [m.fromPlayerId]: e.target.value }))
                        }
                        placeholder={`Reply as ChainMate to ${m.fromName}…`}
                        className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
                      />
                      <Button
                        size="sm"
                        className="w-full sm:w-auto"
                        disabled={busy || !(replyDrafts[m.fromPlayerId] ?? "").trim()}
                        onClick={() => void sendReply(m.fromPlayerId)}
                      >
                        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                        Reply
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        {/* ---------- Broadcast ---------- */}
        <Panel>
          <div className="space-y-3 p-4 sm:p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Volume2 className="h-4 w-4 text-primary" aria-hidden />
              Official announcement
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Sent from the official ChainMate account to every registered
              player&apos;s messages at once.
            </p>
            <textarea
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Tournament starting Saturday, registration is open…"
              className="w-full resize-y rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-mono text-2xs text-muted-foreground">
                {broadcastText.length}/2000
              </span>
              <Button
                size="sm"
                className="w-full sm:w-auto"
                disabled={busy || broadcastText.trim().length === 0}
                onClick={() => void sendBroadcast()}
              >
                {pendingBroadcast === "all" ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Volume2 aria-hidden />
                )}
                Send to everyone
              </Button>
            </div>
          </div>
        </Panel>

        {/* ---------- Tournaments ---------- */}
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
                  <li
                    key={t.id}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
                        {t.status} · {t.format} · host {t.hostName ?? t.id} · {t.entries} player
                        {t.entries === 1 ? "" : "s"}
                        {t.prizePoolNim
                          ? ` · pool ${t.prizePoolNim} NIM (${t.paidEntries} paid @ ${t.entryFeeNim})`
                          : " · free"}
                      </p>
                    </div>
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:shrink-0">
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
                    {(t.payouts.length > 0 || t.refunds.length > 0) && (
                      <PrizeSettlement
                        row={t}
                        playerId={playerId}
                        passcodeToken={passcodeToken}
                        busy={busy}
                        onDone={() => void load()}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        {/* ---------- Active restrictions ---------- */}
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
                  <li
                    key={b.playerId}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm">
                        {names[b.playerId] ?? b.playerId}
                      </p>
                      <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
                        <span className="line-clamp-2">{b.reason}</span>
                        <span className="block sm:inline">
                          {" "}
                          {fmt(b.bannedAt)} · by {names[b.bannedBy] ?? b.bannedBy}
                        </span>
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
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
      </div>

      {error && <ErrorNote message={error} className="mt-4" />}

      {/* ---------- Confirms ---------- */}
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
        open={pendingDelete !== null}
        title={`Permanently delete ${pendingDelete?.username ?? pendingDelete?.playerId ?? ""}?`}
        confirmLabel="Delete forever"
        destructive
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void deleteAccount(pendingDelete);
        }}
      >
        This erases the account, username, rating, history, wallet binding and
        messages. There is no undo and no recovery.
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
        </>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Prize & refund settlement — ChainMate is the sole distributor      */
/* ------------------------------------------------------------------ */

/** Short label for a payout/refund row status, in the console's quiet voice. */
function settlementPill(status: string): { label: string; cls: string } {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "pending", cls: "bg-warning/10 text-warning" },
    dispatching: { label: "sending…", cls: "bg-warning/10 text-warning" },
    sent: { label: "confirming…", cls: "bg-primary/10 text-primary" },
    verified: { label: "paid", cls: "bg-primary/10 text-primary" },
    failed: { label: "retrying", cls: "bg-destructive/10 text-destructive" },
    blocked_no_wallet: { label: "needs wallet", cls: "bg-warning/10 text-warning" },
    // refunds:
    owed: { label: "refund queued", cls: "bg-warning/10 text-warning" },
    dispatched: { label: "returning", cls: "bg-primary/10 text-primary" },
  };
  return map[status] ?? { label: status, cls: "bg-secondary/50 text-muted-foreground" };
}

/** One prize row inside the settlement console (incl. address override). */
function PayoutRow({
  line,
  working,
  busy,
  onPay,
  onCheck,
  onDestination,
}: {
  line: AdminPayoutLine;
  working: string | null;
  busy: boolean;
  onPay: () => void;
  onCheck: () => void;
  onDestination: (address: string) => void;
}) {
  const pill = settlementPill(line.status);
  const settled = line.status === "verified";
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");

  const actionable = !settled && !busy && working === null;

  return (
    <li className="flex flex-col gap-2 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-8 font-mono tabular-nums text-muted-foreground">{line.payoutRank}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{line.playerName ?? line.playerId}</span>
        <span className="font-mono tabular-nums text-muted-foreground">{line.shareBps / 100}%</span>
        <span className="font-mono tabular-nums font-semibold text-primary">{formatNim(BigInt(line.amountLuna))} NIM</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${pill.cls}`}>
          {pill.label}
        </span>
        {!settled && (line.status === "pending" || line.status === "failed" || line.status === "blocked_no_wallet") && (
          <Button size="sm" disabled={!actionable} onClick={onPay}>
            {working?.includes(line.playerId) ? "confirming…" : "pay"}
          </Button>
        )}
        {!settled && (line.status === "sent" || line.status === "dispatching") && (
          <Button size="sm" variant="outline" disabled={!actionable} onClick={onCheck}>
            check status
          </Button>
        )}
        {!settled && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!actionable}
            onClick={() => {
              setEditing((e) => !e);
              setAddress("");
            }}
          >
            address
          </Button>
        )}
      </div>
      {editing && (
        <div className="flex items-center gap-1.5 pl-10">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="NQ… destination address"
            className="min-w-0 flex-1 rounded border border-border/70 bg-background px-2 py-1 font-mono text-2xs outline-none transition-colors focus:border-primary/50"
          />
          <Button
            size="sm"
            disabled={!address.trim() || working !== null}
            onClick={() => {
              onDestination(address.trim());
              setEditing(false);
            }}
          >
            save
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The per-tournament settlement console, embedded under each paid event in
 * the admin table: per-rank prize rows and refund obligations, each with
 * pay/check-status (and an address override for prizes whose winner cannot
 * be resolved). Payments go out through the operator's own Nimiq Pay wallet
 * exactly like the host path did — the difference is WHO is accountable:
 * ChainMate itself, in the ChainMate console.
 */
function PrizeSettlement({
  row,
  playerId,
  passcodeToken,
  busy,
  onDone,
}: {
  row: AdminTournamentRow;
  playerId: string;
  passcodeToken: string;
  busy: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** POST a payout action as the admin; passcode session rides the header. */
  const payoutAction = async (
    action: string,
    targetPlayerId: string,
    txHash?: string,
    destinationAddress?: string,
  ): Promise<Record<string, unknown>> => {
    const token = getIdentityToken();
    const res = await fetch(`/api/tournaments/${encodeURIComponent(row.id)}/payouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Admin-Session": passcodeToken,
      },
      body: JSON.stringify({ playerId, action, targetPlayerId, txHash, destinationAddress }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    if (!res.ok || data.error) throw new Error(String(data.error ?? `Request failed (${res.status})`));
    return data;
  };

  /** Shared wallet send: prepare → Nimiq Pay sheet → claim. */
  const walletSend = async (
    prepareAction: "wallet-prepare" | "refund-prepare",
    claimAction: "wallet-claim" | "refund-claim",
    targetPlayerId: string,
    moved: string,
  ) => {
    const prep = (await payoutAction(prepareAction, targetPlayerId)) as {
      intent: { recipientAddress: string; amountLuna: string };
    };
    const { connectNimiq, sendNimiqBasicTransaction } = await import("@/lib/nimiq/miniapp");
    const { canonicalAddress } = await import("@/lib/nimiq/address");
    const connected = await connectNimiq();
    if (!connected.ok) throw new Error(connected.error.message);
    const sent = await sendNimiqBasicTransaction(connected.value, {
      recipient: canonicalAddress(prep.intent.recipientAddress),
      value: BigInt(prep.intent.amountLuna),
    });
    if (!sent.ok) throw new Error(sent.error.message);
    try {
      await payoutAction(claimAction, targetPlayerId, sent.value);
    } catch {
      // The money has MOVED; the same hash re-claims once confirmations land.
      setNotice(`${moved} (tx ${sent.value.slice(0, 10)}…) — still confirming. Re-press check status in a moment; do NOT send again.`);
      try {
        await payoutAction(claimAction, targetPlayerId, sent.value);
        setNotice(null);
      } catch {
        /* guiding notice stays; never a second payment */
      }
    }
    onDone();
  };

  const payPrize = async (targetPlayerId: string) => {
    setWorking(`prize:${targetPlayerId}`);
    setError(null);
    setNotice(null);
    try {
      await walletSend("wallet-prepare", "wallet-claim", targetPlayerId, "Prize sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sending the prize failed");
    } finally {
      setWorking(null);
    }
  };

  const payRefund = async (targetPlayerId: string) => {
    setWorking(`refund:${targetPlayerId}`);
    setError(null);
    setNotice(null);
    try {
      await walletSend("refund-prepare", "refund-claim", targetPlayerId, "Refund sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Returning the fee failed");
    } finally {
      setWorking(null);
    }
  };

  const checkStatus = async (action: "wallet-confirm" | "refund-confirm", targetPlayerId: string) => {
    setWorking(`check:${targetPlayerId}`);
    setError(null);
    try {
      await payoutAction(action, targetPlayerId);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status check failed");
    } finally {
      setWorking(null);
    }
  };

  const setDestination = async (targetPlayerId: string, addr: string) => {
    setWorking(`dest:${targetPlayerId}`);
    setError(null);
    try {
      await payoutAction("wallet-destination", targetPlayerId, undefined, addr);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the address");
    } finally {
      setWorking(null);
    }
  };

  const poolLabel = row.prizePoolNim ? `${row.prizePoolNim} NIM` : "—";
  const unsettled =
    row.payouts.filter((p) => p.status !== "verified").length +
    row.refunds.filter((r) => r.status !== "verified").length;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        Prizes &amp; refunds — pool {poolLabel}
        {unsettled > 0 ? (
          <span className="ml-auto font-mono normal-case tracking-normal text-warning">
            {unsettled} unsettled
          </span>
        ) : (
          <span className="ml-auto font-mono normal-case tracking-normal text-positive">
            all settled
          </span>
        )}
        <span aria-hidden className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-border/60 p-3">
          {error && <ErrorNote message={error} className="mb-2" />}
          {notice && (
            <p className="mb-2 rounded-md bg-secondary/40 px-3 py-2 text-2xs text-muted-foreground">
              {notice}
            </p>
          )}

          {row.payouts.length > 0 && (
            <ul className="divide-y divide-border/50">
              {row.payouts.map((p) => (
                <PayoutRow
                  key={p.playerId}
                  line={p}
                  working={working}
                  busy={busy}
                  onPay={() => void payPrize(p.playerId)}
                  onCheck={() => void checkStatus("wallet-confirm", p.playerId)}
                  onDestination={(a) => void setDestination(p.playerId, a)}
                />
              ))}
            </ul>
          )}

          {row.refunds.length > 0 && (
            <ul className="divide-y divide-border/50">
              {row.refunds.map((r) => {
                const pill = settlementPill(r.status);
                const settled = r.status === "verified";
                const actionable = !settled && !busy && working === null;
                return (
                  <li key={r.playerId} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                    <span className="w-8 font-mono tabular-nums text-muted-foreground">R</span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {r.playerName ?? r.playerId}
                    </span>
                    <span className="font-mono tabular-nums text-foreground/80">
                      {formatNim(BigInt(r.amountLuna))} NIM
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${pill.cls}`}>
                      {pill.label}
                    </span>
                    {!settled && (r.status === "owed" || r.status === "failed") && (
                      <Button size="sm" variant="outline" disabled={!actionable} onClick={() => void payRefund(r.playerId)}>
                        {working === `refund:${r.playerId}` ? "confirming…" : "return fee"}
                      </Button>
                    )}
                    {!settled && r.status === "dispatched" && (
                      <Button size="sm" variant="ghost" disabled={!actionable} onClick={() => void checkStatus("refund-confirm", r.playerId)}>
                        check status
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
