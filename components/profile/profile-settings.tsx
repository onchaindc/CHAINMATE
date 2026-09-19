"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Award,
  BarChart3,
  Check,
  Globe,
  LifeBuoy,
  Loader2,
  Palette,
  Send,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/ui/page-header";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import {
  BOARD_THEMES,
  PIECE_SETS,
  applyBoardTheme,
  getStoredBoardTheme,
  getStoredPieceSet,
  setStoredBoardTheme,
  setStoredPieceSet,
  type BoardThemeId,
  type PieceSetId,
} from "@/lib/board-prefs";
import { ACHIEVEMENTS } from "@/lib/achievements";
import { COUNTRIES } from "@/lib/countries";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The settings list: one panel with the rows the player actually needs in one
 * place. Support (write to the operator), Friends (opens /friends), Board
 * theme (the chessboard's appearance), Awards (trophy shelf), Stats (quick
 * record), Membership (account standing). Lives on its own /settings page —
 * deliberately not inside the profile, which stays a read-only summary.
 */
export function SettingsList({ stats }: { stats: PlayerStats | null }) {
  const identity = useIdentity();
  const playerId = identity.playerId;
  const token = getIdentityToken();
  const [boardTheme, setBoardThemeState] = useState<BoardThemeId>("gold");
  const [pieceSet, setPieceSetState] = useState<PieceSetId>("classic");
  const [supportText, setSupportText] = useState("");
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportSent, setSupportSent] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [friendsCount, setFriendsCount] = useState<number | null>(null);

  /* Board prefs settle from storage on mount (hydration-safe default above). */
  useEffect(() => {
    setBoardThemeState(getStoredBoardTheme());
    setPieceSetState(getStoredPieceSet());
  }, []);

  useEffect(() => {
    if (identity.isGuest || !playerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await (getStore("hosted") as HostedGameStore).friends();
        if (!cancelled) setFriendsCount(data.friends.length);
      } catch {
        // decorative number; failure is fine
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.isGuest, playerId]);

  const chooseBoard = (id: BoardThemeId) => {
    setBoardThemeState(id);
    applyBoardTheme(id);
    setStoredBoardTheme(id);
  };
  const choosePieces = (id: PieceSetId) => {
    setPieceSetState(id);
    setStoredPieceSet(id);
  };

  const sendSupport = async () => {
    const text = supportText.trim();
    if (!text || supportBusy) return;
    setSupportBusy(true);
    setSupportError(null);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId, action: "send", body: text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setSupportError(data.error ?? "Could not send. Try again.");
      } else {
        setSupportText("");
        setSupportSent(true);
        setTimeout(() => setSupportSent(false), 4000);
      }
    } catch {
      setSupportError("Could not send. Try again.");
    } finally {
      setSupportBusy(false);
    }
  };

  const earned = stats ? stats.achievements.length : 0;
  const total = ACHIEVEMENTS.length;

  const Row = ({
    icon: Icon,
    label,
    hint,
    children,
  }: {
    icon: typeof Award;
    label: string;
    hint?: string;
    children: React.ReactNode;
  }) => (
    <div className="flex flex-col gap-2 border-b border-border/50 px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {hint && <p className="truncate text-2xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );

  return (
    <Panel>
      <Row
        icon={UserRound}
        label="Username"
        hint="3–20 characters · letters, numbers, underscores"
      >
        <SettingsUsernameEditor />
      </Row>

      <Row
        icon={Globe}
        label="Country"
        hint="Shown as a flag beside your name across the app"
      >
        <SettingsCountryEditor />
      </Row>

      <Row
        icon={LifeBuoy}
        label="Support"
        hint="Write to the ChainMate team; replies land in your bell."
      >
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-64">
          <div className="flex gap-2">
            <Input
              value={supportText}
              onChange={(e) => setSupportText(e.target.value)}
              maxLength={2000}
              placeholder="Describe the problem…"
              className="text-sm"
              aria-label="Message support"
            />
            <Button
              size="icon"
              disabled={!supportText.trim() || supportBusy}
              onClick={() => void sendSupport()}
              aria-label="Send to support"
            >
              {supportBusy ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : supportSent ? (
                <Check className="text-positive" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
            </Button>
          </div>
          {supportSent && (
            <p className="text-2xs text-positive">Sent. We reply in your messages.</p>
          )}
          {supportError && <p className="text-2xs text-destructive">{supportError}</p>}
        </div>
      </Row>

      <Row icon={Users} label="Friends" hint={`${friendsCount ?? "…"} friends · manage and search players`}>
        <Link
          href="/friends"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Open
        </Link>
      </Row>

      <Row icon={Palette} label="Board theme" hint="Chessboard colours and piece style">
        <span className="flex items-center gap-1.5">
          {BOARD_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-label={`${t.label} board`}
              onClick={() => chooseBoard(t.id)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md border transition-transform hover:scale-105",
                boardTheme === t.id ? "border-primary ring-2 ring-primary/40" : "border-border/60",
              )}
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--board-light)) 0 50%, hsl(var(--board-dark)) 50% 100%)",
                /* The swatch hues ride on data-board; approximate per theme
                   from the same tokens the board itself uses. */
              }}
              data-board={t.id}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          {PIECE_SETS.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={pieceSet === p.id ? "secondary" : "ghost"}
              onClick={() => choosePieces(p.id)}
            >
              {p.label}
            </Button>
          ))}
        </span>
      </Row>

      <Row
        icon={Award}
        label="Awards"
        hint={`${earned} of ${total} trophies earned`}
      >
        <Link
          href="/profile#awards"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          View shelf
        </Link>
      </Row>

      <Row
        icon={BarChart3}
        label="Stats"
        hint={
          stats
            ? `${stats.games} games · ${stats.wins}W ${stats.losses}L ${stats.draws}D · rating ${stats.rating}`
            : "Loading record…"
        }
      >
        <Link
          href="/leaderboard"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Leaderboard
        </Link>
      </Row>

      <Row
        icon={identity.isGuest ? LifeBuoy : Check}
        label="Membership"
        hint={
          identity.isGuest
            ? "Guest progress on this device only"
            : "Full account, synced across devices"
        }
      >
        {identity.isGuest ? (
          <Link
            href="/auth?upgrade=1"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            Create account
          </Link>
        ) : (
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">
            Active
          </span>
        )}
      </Row>
    </Panel>
  );
}

/** Full-page wrapper used by /settings: header + the settings list. */
export function SettingsPageContent({ stats }: { stats: PlayerStats | null }) {
  return (
    <div>
      <SectionLabel>Manage your account</SectionLabel>
      <div className="mt-3">
        <SettingsList stats={stats} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Profile identity editors — moved here from the profile page          */
/* ------------------------------------------------------------------ */

/**
 * Username editing, in Settings. The profile page stays a read-only summary;
 * everything that CHANGES the account lives behind the gear.
 *
 * State and availability check are the profile page's editor verbatim — the
 * server route (/api/players/me POST with { username }) is unchanged.
 */
function SettingsUsernameEditor() {
  const identity = useIdentity();
  const currentUsername = identity.username;
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "ok" | "taken">("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canEdit = !identity.isGuest && identity.linked;

  useEffect(() => {
    if (!editing) return;
    if (newName.trim().length < 3 || newName.trim().toLowerCase() === currentUsername.toLowerCase()) {
      setState("idle");
      return;
    }
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setState("checking");
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/identity/username?value=${encodeURIComponent(newName.trim())}`);
        if (!res.ok) {
          setState("idle");
          return;
        }
        const data = (await res.json()) as { available?: boolean };
        setState(data.available ? "ok" : "taken");
      } catch {
        setState("idle");
      }
    }, 400);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [editing, newName, currentUsername]);

  const save = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed.length < 3) {
      setError("Username must be at least 3 characters.");
      return;
    }
    if (trimmed.toLowerCase() === currentUsername.toLowerCase()) {
      setEditing(false);
      return;
    }
    if (state === "taken") {
      setError("That username is already taken.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const res = await fetch("/api/players/me", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId: identity.playerId, username: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to update username.");
      await identity.refresh();
      setSuccess(true);
      setEditing(false);
      setTimeout(() => setSuccess(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update username.");
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit) {
    return (
      <span className="text-2xs text-muted-foreground">
        {identity.isGuest ? "Create an account to pick a name" : "Finish account setup first"}
      </span>
    );
  }

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-mono text-sm text-foreground">{currentUsername}</span>
        {success && <span className="text-2xs text-positive">Saved</span>}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(true);
            setNewName(currentUsername);
            setError(null);
            setSuccess(false);
          }}
        >
          Edit
        </Button>
      </span>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-64">
      <div className="flex gap-2">
        <Input
          autoFocus
          value={newName}
          maxLength={20}
          onChange={(e) => {
            setNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, ""));
            setState("idle");
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && !saving && void save()}
          className="text-sm"
          aria-label="New username"
        />
        <Button size="icon" disabled={saving || newName.trim().length < 3} onClick={() => void save()} aria-label="Save username">
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setEditing(false)} aria-label="Cancel">
          <X aria-hidden />
        </Button>
      </div>
      {state === "ok" && <p className="text-2xs text-positive">Available</p>}
      {state === "taken" && <p className="text-2xs text-destructive">That username is taken</p>}
      {state === "checking" && <p className="text-2xs text-muted-foreground">Checking…</p>}
      {error && <p className="text-2xs text-destructive">{error}</p>}
    </div>
  );
}

/** Country editing, in Settings — a plain select, saved to the server. */
function SettingsCountryEditor() {
  const identity = useIdentity();
  const [value, setValue] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (identity.status === "loading" || !identity.playerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const profile = await (getStore("hosted") as HostedGameStore).myProfile(identity.playerId);
        if (!cancelled) {
          setValue(profile.stats.country ?? "");
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.status, identity.playerId]);

  const save = async (next: string) => {
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const res = await fetch("/api/players/me", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ playerId: identity.playerId, country: next || null }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Couldn't save your country. Try again.");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your country. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <select
        value={loaded ? value : ""}
        disabled={saving || !loaded || identity.isGuest}
        onChange={(e) => void save(e.target.value)}
        aria-label="Country"
        className="min-w-40 flex-1 rounded-md border border-border/70 bg-secondary/40 px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60 sm:min-w-52 sm:flex-none"
      >
        <option value="">No country</option>
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
      {saved && <span className="text-2xs text-positive">Saved</span>}
      {error && <span className="text-2xs text-destructive">{error}</span>}
    </div>
  );
}
