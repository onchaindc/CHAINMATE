"use client";

import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";

/**
 * Profile picture upload on the own-profile page. The image is normalized
 * server-side to a 256px webp and served from the avatars bucket, so the
 * same file is sharp everywhere the avatar renders.
 */
export function AvatarUploadCard({ className }: { className?: string }) {
  const identity = useIdentity();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  if (identity.isGuest || !identity.username) return null;

  const avatarUrl = previewUrl ?? identity.avatarUrl ?? null;

  const pick = () => inputRef.current?.click();

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const form = new FormData();
      form.set("playerId", identity.playerId);
      form.set("image", file);
      const res = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { avatarUrl?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setPreviewUrl(data.avatarUrl ?? null);
      await identity.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className={className}>
      <div className="flex items-center gap-4 px-4 py-3.5">
        <PlayerAvatar name={identity.username} avatarUrl={avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">Profile picture</p>
          <p className="mt-0.5 text-2xs leading-snug text-muted-foreground">
            Square images look best. Stored at 256px webp so it stays sharp everywhere.
          </p>
          {error && <p className="mt-1 text-2xs text-destructive">{error}</p>}
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={pick} className="shrink-0">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Camera aria-hidden />}
          {avatarUrl ? "Change" : "Upload"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
    </Panel>
  );
}
