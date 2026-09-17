#!/bin/sh
# Import the OFFICIAL logo file and regenerate every app icon from it.
#
#   sh scripts/import-logo.sh /path/to/logo.png
#
# The official art (public/brand-logo-source.png) is the single source of
# truth. This script derives from its EXACT bytes, UNSCALED — the operator
# rejected zooming the knight: the wordings stay visible, as in the original:
#
#   FULL SQUARE ART for every icon surface:
#     favicon.svg, icon.svg, favicon-32.png, apple-touch-icon.png (180),
#     icon-192.png, icon-512.png, logo-mark.svg, logo.svg, logo-full.svg
#
#   public/site.webmanifest — declares the app NAME so hosts (Nimiq Pay's
#   preview, home screens) render "ChainMate" as their OWN crisp text below
#   the icon instead of straining to read bitmap lettering.
#
# Every SVG wrapper embeds the real raster, so no host ever substitutes a
# font glyph or its own idea of the mark again.
set -eu

SRC="${1:-public/brand-logo-source.png}"
if [ ! -f "$SRC" ]; then
  echo "error: no logo file at '$SRC'" >&2
  echo "usage: sh scripts/import-logo.sh /path/to/logo.(png|jpg|webp)" >&2
  exit 1
fi

SRC="$SRC" node -e '
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const src = process.env.SRC;

/* The operator wants the COMPLETE art everywhere — no crop, no zoom. All
   renders are faithful passes of the source square. */

(async () => {
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height) {
    console.error("error: not a readable raster image:", src);
    process.exit(1);
  }

  // Provenance: the untouched official bytes, committed once, derived from
  // forever after.
  fs.copyFileSync(src, "public/brand-logo-source.png");

  // Faithful full-art renders for EVERY icon surface. No crop, no zoom:
  // the composition (knight + wordings) stays exactly as uploaded.
  const sizes = [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["logo-mark-96.png", 96],
    ["logo-mark-192.png", 192],
    ["logo-render-256.png", 256],
  ];
  for (const [name, size] of sizes) {
    await sharp(src)
      .resize(size, size, { fit: "cover", position: "centre" })
      .png()
      .toFile(path.join("public", name));
  }

  // SVG wrappers embedding the real bytes.
  const embed = (file, box) => {
    const b64 = fs.readFileSync(path.join("public", file)).toString("base64");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}"><image width="${box}" height="${box}" href="data:image/png;base64,${b64}"/></svg>\n`;
  };
  fs.writeFileSync("public/favicon.svg", embed("favicon-32.png", 32));
  fs.writeFileSync("public/icon.svg", embed("icon-192.png", 192));
  fs.writeFileSync("public/logo-mark.svg", embed("logo-mark-96.png", 96));
  fs.writeFileSync("public/logo.svg", embed("logo-render-256.png", 256));
  fs.writeFileSync("public/logo-full.svg", embed("logo-render-256.png", 256));

  // The manifest NAME is what lets hosts draw "ChainMate" as real text
  // under the icon — text they typeset themselves, never bitmap letters.
  const manifest = {
    name: "ChainMate: Play chess. Think deeper.",
    short_name: "ChainMate",
    description: "Competitive chess with intelligent analysis and tournaments.",
    start_url: "/",
    display: "standalone",
    background_color: "#0B0C0E",
    theme_color: "#0B0C0E",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
  fs.writeFileSync("public/site.webmanifest", JSON.stringify(manifest, null, 2) + "\n");

  console.log(`imported ${src} (${meta.width}x${meta.height}) ->`);
  for (const [name] of sizes) console.log("  public/" + name + "  (full art)");
  console.log("  public/{favicon,icon,logo-mark,logo,logo-full}.svg (embedded)");
  console.log("  public/site.webmanifest");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
'
