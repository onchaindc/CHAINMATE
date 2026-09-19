"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, X } from "lucide-react";
import { PlayerAvatar } from "@/components/auth/player-avatar";
import { useIdentity } from "@/lib/identity-context";
import { getIdentityToken } from "@/lib/identity";
import { cn } from "@/lib/utils";

/**
 * Inline profile picture controls.
 *
 * The camera button sits directly ON the header avatar — there is no second
 * avatar elsewhere on the page (the old duplicate card under the wallet card
 * is gone). With a picture set, a small ✕ appears as the second action: one
 * tap removes the picture and restores the default initial avatar.
 */

/** The avatar + its camera/remove controls. Drops into the profile header. */
export function AvatarControls({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
}) {
  const identity = useIdentity();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const showControls = !identity.isGuest && Boolean(identity.username);
  const currentUrl = previewUrl ?? avatarUrl ?? identity.avatarUrl ?? null;

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

  const remove = async () => {
    if (!currentUrl || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const token = getIdentityToken();
      const res = await fetch(
        `/api/profile/avatar?playerId=${encodeURIComponent(identity.playerId)}`,
        { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to remove");
      setPreviewUrl(null);
      await identity.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className={cn("relative shrink-0", className)}>
      <div className="relative inline-block">
        {busy ? (
          <div className="flex h-24 w-24 items-center justify-center rounded-full border border-border/60 bg-secondary/40">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : (
          <PlayerAvatar name={name} avatarUrl={currentUrl} size="lg" />
        )}
        {showControls && (
          <>
            {/* Change/upload — pinned to the avatar itself. */}
            <button
              type="button"
              onClick={pick}
              disabled={busy || removing}
              aria-label={currentUrl ? "Change profile picture" : "Upload profile picture"}
              className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-md transition-all hover:border-primary/50 hover:text-primary active:scale-95 disabled:opacity-60"
            >
              <Camera className="h-3.5 w-3.5" aria-hidden />
            </button>
            {/* Remove — only when a picture exists, restores the default avatar. */}
            {currentUrl && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy || removing}
                aria-label="Remove profile picture"
                className="absolute -left-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-all hover:border-destructive/50 hover:text-destructive active:scale-95 disabled:opacity-60"
              >
                {removing ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : (
                  <X className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            )}
          </>
        )}
      </div>
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
      {error && <p className="mt-2 text-2xs text-destructive">{error}</p>}
    </div>
  );
}
