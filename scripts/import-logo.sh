#!/bin/sh
# Import the OFFICIAL logo file and regenerate every app icon from it.
#
#   sh scripts/import-logo.sh /path/to/logo.png
#
# Why this script exists: images pasted into chat reach the user's client but
# never reach this workspace's filesystem, so the app cannot be handed the
# real artwork directly in conversation. The guaranteed paths are (a) commit
# the file into the repo, or (b) give the agent a direct URL to fetch. This
# script turns that one source file into every asset the app serves, so the
# knight mark is byte-identical everywhere: browser tab, home screens, and
# the Nimiq Pay mini-app icon.
#
# Inputs: any raster the official logo exists as (png/jpg/webp).
# Outputs (all under public/):
#   brand-logo-source.png   untouched copy of the official file (provenance)
#   favicon.svg, icon.svg   square SVG wrapper with the art embedded
#   logo-mark.svg, logo.svg, logo-full.svg   same wrapper (nav/loading/stacked)
#   favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png
#   (site.webmanifest is static; it points at the PNGs this writes.)
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

(async () => {
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height) {
    console.error("error: not a readable raster image:", src);
    process.exit(1);
  }

  // Keep the original bytes in the repo: the provenance copy every later
  // regeneration starts from.
  fs.copyFileSync(src, "public/brand-logo-source.png");

  // Raster set. The art already carries its own dark tile, so renders are
  // faithful passes — no recomposition, no invented geometry.
  const sizes = [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["logo-render-96.png", 96],
    ["logo-render-256.png", 256],
  ];
  for (const [name, size] of sizes) {
    await sharp(src)
      .resize(size, size, { fit: "cover", position: "centre" })
      .png()
      .toFile(path.join("public", name));
  }

  // SVG wrappers: a minimal square canvas with the raster embedded. Vector
  // redraws drifted from the official art, so the served SVG now carries the
  // real bytes — visually identical at every size, everywhere.
  const embed = (render, box) => {
    const b64 = fs.readFileSync(path.join("public", render)).toString("base64");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}"><image width="${box}" height="${box}" href="data:image/png;base64,${b64}"/></svg>\n`;
  };
  fs.writeFileSync("public/favicon.svg", embed("favicon-32.png", 32));
  fs.writeFileSync("public/icon.svg", embed("icon-192.png", 192));
  fs.writeFileSync("public/logo-mark.svg", embed("logo-render-96.png", 96));
  fs.writeFileSync("public/logo.svg", embed("logo-render-96.png", 96));
  fs.writeFileSync("public/logo-full.svg", embed("logo-render-256.png", 256));

  console.log(`imported ${src} (${meta.width}x${meta.height}) ->`);
  for (const [name] of sizes) console.log("  public/" + name);
  console.log("  public/{favicon,icon,logo-mark,logo,logo-full}.svg (embedded)");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
'
