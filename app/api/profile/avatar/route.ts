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
 * Storage setup (once, in the Supabase dashboard): a PUBLIC bucket named
 * `avatars`. See supabase/migrations/0011_avatars.sql for the SQL.
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
    const { error: uploadError } = await admin.storage
      .from("avatars")
      .upload(path, buffer, { contentType: "image/webp", upsert: true });
    if (uploadError) {
      return NextResponse.json(
        { error: "Storage isn't ready: create the public `avatars` bucket (see 0011_avatars.sql)." },
        { status: 500 },
      );
    }
    const { data } = admin.storage.from("avatars").getPublicUrl(path);
    const { error: updateError } = await admin
      .from("profiles")
      .update({ avatar_url: data.publicUrl })
      .eq("player_id", acting.playerId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, avatarUrl: data.publicUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
