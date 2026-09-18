import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { profileForPlayerId } from "@/lib/supabase/db";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Profile picture upload.
 *
 * The image is resized server-side to a 256x256 webp (avatars never need
 * more, and one canonical size kills the blur-from-huge-original problem),
 * stored in the `avatars` bucket under the player id, and the public URL is
 * written onto the profile row. Requires a signed-in account — guests have
 * no profile row to attach it to.
 *
 * The public `avatars` bucket is provisioned here on demand (and by
 * supabase/migrations/0011_avatars.sql), so a fresh Supabase project works
 * without a dashboard detour.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const claimed = String(form.get("playerId") ?? "").trim();
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }

  const profile = await profileForPlayerId(acting.playerId);
  if (!profile || profile.is_guest) {
    return NextResponse.json(
      { error: "Sign in to set a profile picture: guests have no account to attach one to." },
      { status: 403 },
    );
  }

  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image file received" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large (5 MB max)" }, { status: 400 });
  }
  if (!/^image\//.test(file.type)) {
    return NextResponse.json({ error: "That file is not an image" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Accounts aren't configured yet." }, { status: 503 });
  }

  try {
    // Normalize to a 256px webp: same bytes out no matter what the camera
    // uploaded, tiny enough to load instantly everywhere the avatar shows.
    const sharp = (await import("sharp")).default;
    const buffer = await sharp(Buffer.from(await file.arrayBuffer()))
      .resize(256, 256, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();

    const path = `${acting.playerId}.webp`;
    // Cache version: the storage path never changes across re-uploads, so a
    // bare URL would keep serving the cached previous picture forever (the
    // reported "can't change my pfp" bug). Every upload bumps ?v=, which
    // busts both browser and CDN caches for every viewer at once.
    const cacheVersion = String(Date.now());
    const { error: uploadError } = await admin.storage
      .from("avatars")
      .upload(path, buffer, { contentType: "image/webp", upsert: true });
    if (uploadError) {
      // A brand-new Supabase project has no buckets yet. Create the public
      // one and retry the upload once before giving up (migration 0011 does
      // the same thing idempotently for SQL-driven setups).
      if (/bucket/i.test(uploadError.message) && /not found/i.test(uploadError.message)) {
        await admin.storage.createBucket("avatars", { public: true }).catch(() => {});
        const retried = await admin.storage
          .from("avatars")
          .upload(path, buffer, { contentType: "image/webp", upsert: true });
        if (!retried.error) {
          const { data: retryUrl } = admin.storage.from("avatars").getPublicUrl(path);
          const versioned = `${retryUrl.publicUrl}?v=${cacheVersion}`;
          const { error: retryUpdateError } = await admin
            .from("profiles")
            .update({ avatar_url: versioned })
            .eq("player_id", acting.playerId);
          if (retryUpdateError) {
            return NextResponse.json({ error: retryUpdateError.message }, { status: 500 });
          }
          return NextResponse.json({ ok: true, avatarUrl: versioned });
        }
      }
      // Still failing: the operator's setup, not the player's fault, so the
      // message stays generic rather than surfacing migration instructions.
      console.error("avatar upload failed (missing avatars bucket?)", uploadError.message);
      return NextResponse.json(
        { error: "Profile pictures are unavailable right now. Please try again later." },
        { status: 503 },
      );
    }
    const { data } = admin.storage.from("avatars").getPublicUrl(path);
    const versioned = `${data.publicUrl}?v=${cacheVersion}`;
    const { error: updateError } = await admin
      .from("profiles")
      .update({ avatar_url: versioned })
      .eq("player_id", acting.playerId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, avatarUrl: versioned });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
