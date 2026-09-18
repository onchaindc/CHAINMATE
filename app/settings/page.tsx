"use client";

import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { RequireProfile } from "@/components/auth/require-profile";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { LoadingRows, ErrorNote } from "@/components/ui/states";
import { SettingsPageContent } from "@/components/profile/profile-settings";
import { useIdentity } from "@/lib/identity-context";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";
import type { PlayerStats } from "@/lib/types";

export default function SettingsPage() {
  return (
    <RequireProfile>
      <SettingsContent />
    </RequireProfile>
  );
}

function SettingsContent() {
  const identity = useIdentity();
  const playerId = identity.playerId;
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (identity.status === "loading" || !playerId) return;
    let cancelled = false;
    (async () => {
      try {
        const hosted = getStore("hosted") as HostedGameStore;
        const profile = await hosted.myProfile(playerId);
        if (!cancelled) setStats(profile.stats);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load your record");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.status, playerId]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 lg:py-14">
      <BackLink href="/profile">Back to profile</BackLink>
      <div className="mt-4">
        <PageHeader
          eyebrow="Your account"
          eyebrowIcon={Settings}
          title="Settings"
          description="Support, friends, board theme, awards, stats and membership — the things you manage, in one place."
        />
      </div>
      {error && <ErrorNote message={error} className="mt-6" />}
      <div className="mt-6">
        {stats === null && !error ? <LoadingRows /> : <SettingsPageContent stats={stats} />}
      </div>
    </div>
  );
}
