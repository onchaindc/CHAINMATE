"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, Globe } from "lucide-react";
import { RequireProfile } from "@/components/auth/require-profile";
import { Button, buttonVariants } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { AchievementGrid } from "@/components/game/achievement-grid";
import { FriendsPanel } from "@/components/profile/friends-panel";
import { GuestBanner } from "@/components/auth/guest-banner";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { COUNTRIES, countryName, flagFor } from "@/lib/countries";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { mergeGamesById, cn } from "@/lib/utils";
import { getIdentityToken } from "@/lib/identity";
import { Input } from "@/components/ui/input";
import type { GameState, PlayerStats } from "@/lib/types";

export default function ProfilePage() {
  return (
    <RequireProfile>
      <ProfileContent />
    </RequireProfile>
  );
}

function ProfileContent() {
  const identity = useIdentity();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [games, setGames] = useState<GameState[] | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerInfo>>({});
  const [error, setError] = useState<string | null>(null);

  // Real usernames for everyone in the recent-games list.
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(players)) {
      if (info.name) map[info.id] = info.name;
    }
    return map;
  }, [players]);

  // The active player id: the account's id when signed in, the device
  // guest id otherwise.
  const playerId = identity.playerId;
  const localMe = useMemo(() => getStore("local").getMyPlayerId(), []);
  const hostedStore = useMemo(() => getStore("hosted") as HostedGameStore, []);
  const [savingCountry, setSavingCountry] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [profile, localGames] = await Promise.all([
          hosted.myProfile(),
          Promise.resolve(local.listMyGames()),
        ]);
        if (cancelled) return;
        setStats(profile.stats);
        setPlayers(profile.players);
        setGames(mergeGamesById([...profile.games, ...localGames]));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load profile");
        setGames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // playerId drives the fetch — refresh when identity changes.
  }, [playerId]);

  const name = identity.username || "Player";
  const rating = stats?.rating ?? identity.rating;
  const provisional = stats ? stats.games < 5 : false;
  const winRate =
    stats && stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : null;
  const streak = stats?.currentStreak ?? 0;
  const country = stats?.country;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="animate-fade-in-up flex flex-wrap items-center gap-4">
        <PlayerAvatar name={name} size="lg" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            {country && (
              <span
                className="text-xl leading-none"
                title={countryName(country) ?? undefined}
                aria-label={countryName(country) ?? undefined}
              >
                {flagFor(country)}
              </span>
            )}
            <h1 className="font-display truncate text-2xl font-bold tracking-tight">{name}</h1>
            {identity.isGuest ? (
              <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Guest
              </span>
            ) : (
              <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                Account
              </span>
            )}
            {stats && provisional && (
              <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Provisional
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {identity.isGuest
              ? "Guest — casual play, nothing is saved. Sign up for a permanent record."
              : "ChainMate player — signed in and synced across devices"}
          </p>
        </div>
        {rating !== null && (
          <div className="ml-auto text-right">
            <p className="font-mono text-2xl font-bold tabular-nums text-primary">{rating}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              ELO rating
            </p>
          </div>
        )}
      </div>

      {identity.isGuest && (
        <div className="mt-6 animate-fade-in-up [animation-delay:60ms]">
          <GuestBanner />
        </div>
      )}

      {/* Optional country — editable, shown as a flag next to the name */}
      <div className="mt-6 flex animate-fade-in-up items-center gap-3 rounded-lg border border-border/70 bg-card/50 px-4 py-3 [animation-delay:60ms]">
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <label
          htmlFor="country"
          className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Country
        </label>
        <select
          id="country"
          value={country ?? ""}
          disabled={savingCountry}
          onChange={(e) => {
            const value = e.target.value;
            setSavingCountry(true);
            void hostedStore
              .setCountry(value || null)
              .then((next) =>
                setStats((prev) => (prev ? { ...prev, country: next.country } : prev)),
              )
              .catch(() => setError("Couldn't save your country — try again."))
              .finally(() => setSavingCountry(false));
          }}
          className="min-w-0 flex-1 rounded-md border border-border/70 bg-secondary/40 px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-primary/50"
        >
          <option value="">No country</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {flagFor(c.code)} {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Username — editable for authenticated users */}
      {!identity.isGuest && (
        <ProfileUsernameEditor
          currentUsername={identity.username}
          playerId={playerId}
          onUpdated={(newName) => {
            setStats((prev) => (prev ? { ...prev, username: newName } : prev));
            // Sync the identity context so the header and profile display
            // the new name immediately without requiring a full page refresh.
            void identity.refresh();
          }}
        />
      )}

      {error && (
        <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-8 grid animate-fade-in-up grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 sm:grid-cols-5">
        {[
          { label: "Games", value: stats ? String(stats.games) : "—" },
          { label: "Wins", value: stats ? String(stats.wins) : "—" },
          { label: "Losses", value: stats ? String(stats.losses) : "—" },
          { label: "Draws", value: stats ? String(stats.draws) : "—" },
          {
            label: "Win rate",
            value: winRate !== null ? `${winRate}%` : "—",
          },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-xl font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid animate-fade-in-up grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/60 [animation-delay:80ms]">
        {[
          { label: "Peak rating", value: stats ? String(stats.peakRating) : "—" },
          {
            label: "Streak",
            value: stats ? (streak === 0 ? "—" : `${streak > 0 ? "+" : ""}${streak}`) : "—",
          },
          { label: "Best streak", value: stats ? `+${stats.bestStreak}` : "—" },
        ].map((s) => (
          <div key={s.label} className="bg-card/50 px-4 py-4">
            <p className="font-mono text-lg font-bold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {s.label}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {provisional
          ? "Provisional rating — updates after rated online matches between two human players."
          : "Rating and streaks update after rated online matches between two human players."}
      </p>

      {/* Achievements */}
      <div className="mt-10 animate-fade-in-up [animation-delay:120ms]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Achievements
          {stats && stats.achievements.length > 0 && (
            <span className="ml-2 font-mono text-primary">
              {stats.achievements.length}/{10}
            </span>
          )}
        </h2>
        <div className="mt-3">
          {stats ? (
            <AchievementGrid stats={stats} />
          ) : (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-secondary/60" />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Friends + player search */}
      <div className="mt-10 animate-fade-in-up [animation-delay:140ms]">
        <FriendsPanel store={hostedStore} />
      </div>

      {/* Recent games */}
      <div className="mt-10 animate-fade-in-up [animation-delay:160ms]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent games
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/50">
          {games === null ? (
            <div className="space-y-1 px-2 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-secondary/60" />
              ))}
            </div>
          ) : games.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <p className="text-sm font-medium text-foreground/85">No games yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Play your first match to start building a record.
              </p>
              <Link href="/create" className={cn(buttonVariants({ size: "sm" }), "mt-5")}>
                Create a game
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border/50 px-2 py-2">
              {games.slice(0, 10).map((game) => (
                <GameRow
                  key={game.id}
                  game={game}
                  me={game.backend === "local" ? localMe : playerId}
                  names={game.backend === "local" ? undefined : names}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Danger zone — delete account */}
      {!identity.isGuest && (
        <div className="mt-10 animate-fade-in-up [animation-delay:180ms]">
          <DeleteAccountSection />
        </div>
      )}
    </div>
  );
}

function DeleteAccountSection() {
  const identity = useIdentity();
  const router = useRouter();
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const res = await fetch("/api/players/me", {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to delete account.");
      }
      // Clear local identity and redirect
      await identity.signOut();
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account.");
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
        Danger zone
      </h3>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Permanently delete your account, username, rating, game history, achievements, and friend connections. This cannot be undone.
      </p>

      {confirmStep === 0 && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3 border-destructive/40 text-destructive hover:bg-destructive/10"
          onClick={() => setConfirmStep(1)}
        >
          Delete account
        </Button>
      )}

      {confirmStep === 1 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-destructive">
            Are you sure? This will permanently delete your account ({identity.username || "Player"}) and all associated data.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => setConfirmStep(2)}
              disabled={busy}
            >
              Yes, delete everything
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmStep(0)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {confirmStep === 2 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-destructive">
            Type your username to confirm: {identity.username || "Player"}
          </p>
          <ConfirmDeleteInput
            expected={identity.username || "Player"}
            onConfirm={handleDelete}
            onCancel={() => setConfirmStep(0)}
            busy={busy}
          />
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

function ConfirmDeleteInput({
  expected,
  onConfirm,
  onCancel,
  busy,
}: {
  expected: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={expected}
        className="flex-1"
        onKeyDown={(e) => e.key === "Enter" && value.toLowerCase() === expected.toLowerCase() && onConfirm()}
      />
      <Button
        size="sm"
        variant="destructive"
        onClick={onConfirm}
        disabled={busy || value.toLowerCase() !== expected.toLowerCase()}
      >
        {busy ? "Deleting…" : "Confirm"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

function ProfileUsernameEditor({
  currentUsername,
  playerId,
  onUpdated,
}: {
  currentUsername: string;
  playerId: string;
  onUpdated: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [usernameState, setUsernameState] = useState<"idle" | "checking" | "ok" | "taken">("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (newName.trim().length < 3 || newName.trim().toLowerCase() === currentUsername.toLowerCase()) {
      setUsernameState("idle");
      return;
    }
    if (checkTimer.current) clearTimeout(checkTimer.current);
    setUsernameState("checking");
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/identity/username?value=${encodeURIComponent(newName.trim())}`);
        if (!res.ok) { setUsernameState("idle"); return; }
        const data = (await res.json()) as { available?: boolean };
        setUsernameState(data.available ? "ok" : "taken");
      } catch { setUsernameState("idle"); }
    }, 400);
    return () => { if (checkTimer.current) clearTimeout(checkTimer.current); };
  }, [newName, currentUsername]);

  const save = async () => {
    const trimmed = newName.trim();
    if (trimmed.length < 3) { setError("Username must be at least 3 characters."); return; }
    if (trimmed.toLowerCase() === currentUsername.toLowerCase()) { setEditing(false); return; }
    if (usernameState === "taken") { setError("That username is already taken."); return; }
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
        body: JSON.stringify({ playerId, username: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Failed to update username.");
      onUpdated(trimmed);
      setSuccess(true);
      setEditing(false);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update username.");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="mt-4 flex animate-fade-in-up items-center gap-3 rounded-lg border border-border/70 bg-card/50 px-4 py-3 [animation-delay:80ms]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Username</span>
        <span className="flex-1 font-mono text-sm text-foreground">{currentUsername}</span>
        {success && (
          <span className="text-[11px] text-primary">Saved</span>
        )}
        <button
          type="button"
          onClick={() => { setEditing(true); setNewName(currentUsername); setError(null); setSuccess(false); }}
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-border/70 bg-card/50 p-4 animate-fade-in-up [animation-delay:80ms]">
      <label htmlFor="edit-username" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {currentUsername ? "Edit Username" : "Set Username"}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <Input
          id="edit-username"
          autoFocus
          value={newName}
          maxLength={20}
          onChange={(e) => { setNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, "")); setUsernameState("idle"); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && !saving && void save()}
          className="flex-1"
        />
        <Button size="sm" onClick={() => void save()} disabled={saving || newName.trim().length < 3}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {usernameState === "ok" && <p className="mt-1 text-[11px] text-primary">Available</p>}
      {usernameState === "taken" && <p className="mt-1 text-[11px] text-destructive">That username is taken</p>}
      {usernameState === "checking" && <p className="mt-1 text-[11px] text-muted-foreground">Checking…</p>}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
      <p className="mt-1 text-[11px] text-muted-foreground">
        3–20 characters · letters, numbers, underscores.
      </p>
    </div>
  );
}