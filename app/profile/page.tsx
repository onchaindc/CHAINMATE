"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Gamepad2, Globe } from "lucide-react";
import { RequireProfile } from "@/components/auth/require-profile";
import { Button } from "@/components/ui/button";
import { GameRow } from "@/components/game/game-row";
import { AchievementGrid } from "@/components/game/achievement-grid";
import { FriendsPanel } from "@/components/profile/friends-panel";
import { NimiqWalletCard } from "@/components/profile/nimiq-wallet-card";
import { ProfileBadge, ProfileHeader } from "@/components/profile/profile-header";
import { AvatarUploadCard } from "@/components/profile/avatar-upload-card";
import { RecentForm } from "@/components/profile/recent-form";
import { StatTiles, formatStreak } from "@/components/profile/stat-tiles";
import { GuestBanner } from "@/components/auth/guest-banner";
import { COUNTRIES } from "@/lib/countries";
import { SectionLabel } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState, ErrorNote, LoadingRows } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { LocalGameStore } from "@/lib/store/local-store";
import { HostedGameStore, type PlayerInfo } from "@/lib/store/hosted-store";
import { mergeGamesById } from "@/lib/utils";
import { getIdentityToken, guestDisplayName } from "@/lib/identity";
import { Input } from "@/components/ui/input";
import { isPlayedGame, type GameState, type PlayerStats } from "@/lib/types";

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

  /**
   * Rating change per game, for the history rows.
   *
   * The stats history is a recent window and can be missing older games, so the
   * game's own `ratings` stamp — written when the game was rated and kept —
   * takes precedence where both have an entry.
   */
  const deltas = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of stats?.ratingHistory ?? []) map.set(h.gameId, h.change);
    for (const g of games ?? []) {
      const change = g.ratings?.[playerId]?.change;
      if (change !== undefined) map.set(g.id, change);
    }
    return map;
  }, [stats?.ratingHistory, games, playerId]);

  useEffect(() => {
    // Wait for the real identity. Fetching on the interim id served the device
    // guest's empty record to a signed-in player, and because the effect only
    // re-ran on `playerId` the correct stats never replaced it if the id was
    // resolved before this component mounted.
    if (identity.status === "loading" || !playerId) return;
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const local = getStore("local") as LocalGameStore;
        const [profile, localGames] = await Promise.all([
          hosted.myProfile(playerId),
          Promise.resolve(local.listMyGames()),
        ]);
        if (cancelled) return;
        setStats(profile.stats);
        setPlayers(profile.players);
        setGames(mergeGamesById([...profile.games, ...localGames]).filter(isPlayedGame));
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
  }, [playerId, identity.status]);

  // "Player" is a display placeholder only — never a saveable name. When the
  // account has no profiles row (identity.linked === false) a rename cannot
  // persist, so the banner below says so instead of letting this placeholder
  // look like a name that just refuses to change.
  const name = guestDisplayName(identity.username) || "Player";
  const rating = stats?.rating ?? identity.rating;
  const provisional = stats ? stats.games < 5 : false;
  const winRate =
    stats && stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : null;
  const streak = stats?.currentStreak ?? 0;
  const country = stats?.country;

  return (
    /* Two columns from `lg`, starting right under the identity header. The
       header deliberately sits ABOVE the grid: inside it, it became a grid
       item, the account stack spilled into the right column, and achievements
       drifted to a row of its own — a big hole under the name. Here the left
       column is the account stack and the right column holds friends,
       achievements and games from the same top line, so nothing floats. */
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:py-14">
      <ProfileHeader
        name={name}
        eyebrow="Your profile"
        country={country}
        rating={rating}
        ratingDelta={stats?.ratingHistory?.[0]?.change ?? null}
        isGuest={identity.isGuest}
        avatarUrl={identity.avatarUrl ?? stats?.avatarUrl}
        joinedAt={stats?.createdAt}
        badges={stats && provisional && <ProfileBadge>Provisional</ProfileBadge>}
        description={
          identity.isGuest
            ? "Guest: casual play, nothing is saved. Sign up for a permanent record."
            : "ChainMate player: signed in and synced across devices"
        }
      />

      {identity.isGuest && (
        <div className="mt-6 animate-fade-in-up [animation-delay:60ms]">
          <GuestBanner />
        </div>
      )}

      {error && <ErrorNote message={error} className="mt-6" />}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
      {/* ============ LEFT COLUMN — the main contents ============ */}
      <div className="min-w-0 space-y-6">
      {/* Optional country — editable, shown as a flag next to the name */}
      <Panel className="flex animate-fade-in-up items-center gap-3 px-4 py-3 [animation-delay:60ms]">
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <label
          htmlFor="country"
          className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
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
              .catch(() => setError("Couldn't save your country. Try again."))
              .finally(() => setSavingCountry(false));
          }}
          className="min-w-0 flex-1 rounded-md border border-border/70 bg-secondary/40 px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-primary/50"
        >
          <option value="">No country</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {/* Native <option> renders text only, so no flag component here.
                  The name alone reads correctly on every platform — an emoji
                  flag would degrade to bare letters beside it on Windows. */}
              {c.name}
            </option>
          ))}
        </select>
      </Panel>

      {/* Username — editable for authenticated users */}
      {!identity.isGuest && !identity.linked && (
        <ErrorNote
          tone="warning"
          className="mt-6"
          message="Account not linked to a profile yet: sign out and back in to finish setup."
        />
      )}

      {!identity.isGuest && identity.linked && (
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

      {error && <ErrorNote message={error} className="mt-6" />}

      {/* Nimiq wallet binding — real provider flow, server-verified link. */}
      <NimiqWalletCard playerId={playerId} />

      {/* Profile picture — upload/replace, normalized server-side. */}
      <AvatarUploadCard className="animate-fade-in-up [animation-delay:70ms]" />

      {/* Stats */}
      <StatTiles
        layout="five"
        className="mt-8 animate-fade-in-up [animation-delay:80ms]"
        tiles={[
          { label: "Games", value: stats ? String(stats.games) : "—" },
          { label: "Wins", value: stats ? String(stats.wins) : "—" },
          { label: "Losses", value: stats ? String(stats.losses) : "—" },
          { label: "Draws", value: stats ? String(stats.draws) : "—" },
          { label: "Win rate", value: winRate !== null ? `${winRate}%` : "—" },
        ]}
      />

      <StatTiles
        layout="three"
        size="sm"
        className="mt-4 animate-fade-in-up [animation-delay:100ms]"
        tiles={[
          { label: "Peak rating", value: stats ? String(stats.peakRating) : "—" },
          stats ? formatStreak(streak) : { label: "Streak", value: "—" },
          { label: "Best streak", value: stats ? `${stats.bestStreak}W` : "—" },
        ]}
      />
      <p className="mt-2 text-2xs text-muted-foreground">
        {provisional
          ? "Provisional rating: updates after rated online matches between two human players."
          : "Rating and streaks update after rated online matches between two human players."}
      </p>

      {/* Form — the record above, in the order it happened. */}
      <RecentForm
        history={stats?.ratingHistory}
        games={games ?? undefined}
        playerId={playerId}
        streak={streak}
        loading={stats === null}
        showTrend
        className="mt-4 [animation-delay:120ms]"
      />
      </div>

      {/* ============ RIGHT COLUMN ============ */}
      <div className="min-w-0 space-y-10">
        {/* Achievements: a compact trophy card, expandable to the full shelf. */}
        <div className="animate-fade-in-up [animation-delay:140ms]">
          {stats ? (
            <AchievementGrid stats={stats} />
            ) : (
              <LoadingRows className="px-0" rowClassName="h-12 rounded-lg" />
            )}
        </div>

        {/* Recent games — below achievements, with the friends panel between
            them so the pairing breathes instead of stacking tight. On `lg` the
            two columns start together, so this lands mid-page rather than at
            the very bottom. */}
        <div className="animate-fade-in-up [animation-delay:180ms]">
          <SectionLabel>Recent games</SectionLabel>
          <Panel className="mt-3">
            {games === null ? (
              <LoadingRows />
            ) : games.length === 0 ? (
              <EmptyState
                icon={Gamepad2}
                title="No games yet"
                description="Your games appear here."
                action={{ href: "/create", label: "Create a game" }}
                className="py-14"
              />
            ) : (
              <div className="divide-y divide-border/50 px-2 py-2">
                {games.slice(0, 10).map((game) => (
                  <GameRow
                    key={game.id}
                    game={game}
                    me={game.backend === "local" ? localMe : playerId}
                    /* Local games are never rated, so they hold the column open
                       with a blank rather than claiming a delta of zero. */
                    delta={game.backend === "local" ? null : deltas.get(game.id) ?? null}
                    names={game.backend === "local" ? undefined : names}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
      </div>

      {/* Friends + player search — full width beneath both columns, so the
          search input gets the room it deserves and the right column doesn't
          grow an endless tail. */}
      <div className="mt-10 animate-fade-in-up [animation-delay:160ms]">
        <FriendsPanel store={hostedStore} />
      </div>

      {/* Danger zone — delete account */}
      {!identity.isGuest && (
        <div className="mt-10 animate-fade-in-up [animation-delay:200ms]">
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
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-destructive">
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
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Username</span>
        <span className="flex-1 font-mono text-sm text-foreground">{currentUsername}</span>
        {success && (
          <span className="text-2xs text-primary">Saved</span>
        )}
        <button
          type="button"
          onClick={() => { setEditing(true); setNewName(currentUsername); setError(null); setSuccess(false); }}
          className="text-2xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-border/70 bg-card/50 p-4 animate-fade-in-up [animation-delay:80ms]">
      <label htmlFor="edit-username" className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
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
      {usernameState === "ok" && <p className="mt-1 text-2xs text-primary">Available</p>}
      {usernameState === "taken" && <p className="mt-1 text-2xs text-destructive">That username is taken</p>}
      {usernameState === "checking" && <p className="mt-1 text-2xs text-muted-foreground">Checking…</p>}
      {error && <p className="mt-1 text-2xs text-destructive">{error}</p>}
      <p className="mt-1 text-2xs text-muted-foreground">
        3–20 characters · letters, numbers, underscores.
      </p>
    </div>
  );
}