"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Award,
  BarChart3,
  Check,
  LifeBuoy,
  Loader2,
  Palette,
  Send,
  Users,
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
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Settings, at the bottom of the profile: one panel with the rows the player
 * actually needs in one place. Support (write to the operator), Friends
 * (jump to the panel above), Board theme (the chessboard's appearance),
 * Awards (trophy shelf summary), Stats (quick record), Membership (account
 * standing). Compact by design: links and steppers, not a second page.
 */
export function ProfileSettingsSection({ stats }: { stats: PlayerStats | null }) {
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
    <div>
      <SectionLabel>Settings</SectionLabel>
      <Panel className="mt-3">
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
            href="/profile#friends"
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
    </div>
  );
}
