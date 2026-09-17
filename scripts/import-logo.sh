#!/bin/sh
# Import the OFFICIAL logo file and regenerate every app icon from it.
#
#   sh scripts/import-logo.sh /path/to/logo.png
#
# The official art (public/brand-logo-source.png) is the single source of
# truth. This script derives from its EXACT bytes:
#
#   Knight figure ONLY for every ICON surface:
#     favicon.svg, icon.svg, favicon-32.png, apple-touch-icon.png (180),
#     icon-192.png, icon-512.png, logo-mark.svg
#     (Text in an icon dissolves at 32-192px — the Nimiq Pay preview showed
#     exactly that blur. Icons must carry the figure alone; hosts show the
#     NAME beside the icon in their own text, never inside it.)
#
#   Full square art for large brand surfaces:
#     logo.svg, logo-full.svg, logo-render-256.png
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

/* Knight-figure crop within the official 1254x1254 art, measured from the
   pixels: the figure (ivory knight + dark circuit twin) spans x 479..784,
   y 293..758. The square below centers that box with even margins. If the
   official art is ever replaced, re-measure or set CROP=0 to use the full
   square for the mark too. */
const MARK_CROP = process.env.MARK_CROP === "0" ? null : { left: 366, top: 260, size: 531 };

(async () => {
  const meta = await sharp(src).metadata();
  if (!meta.width || !meta.height) {
    console.error("error: not a readable raster image:", src);
    process.exit(1);
  }

  // Provenance: the untouched official bytes, committed once, derived from
  // forever after.
  fs.copyFileSync(src, "public/brand-logo-source.png");

  // Knight-figure renders for every ICON surface (see header: text in icons
  // dissolves; the figure alone reads cleanly at 32px).
  const iconSizes = [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["logo-mark-96.png", 96],
    ["logo-mark-192.png", 192],
  ];
  for (const [name, size] of iconSizes) {
    if (MARK_CROP) {
      await sharp(src)
        .extract({ left: MARK_CROP.left, top: MARK_CROP.top, width: MARK_CROP.size, height: MARK_CROP.size })
        .resize(size, size)
        .png()
        .toFile(path.join("public", name));
    } else {
      await sharp(src)
        .resize(size, size, { fit: "cover", position: "centre" })
        .png()
        .toFile(path.join("public", name));
    }
  }

  // Full-art render for the large brand surfaces.
  await sharp(src)
    .resize(256, 256, { fit: "cover", position: "centre" })
    .png()
    .toFile(path.join("public", "logo-render-256.png"));

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

  console.log(`imported ${src} (${meta.width}x${meta.height}) ->`);
  for (const [name] of iconSizes) console.log("  public/" + name + "  (knight figure)");
  console.log("  public/logo-render-256.png  (full art)");
  console.log("  public/{favicon,icon,logo-mark}.svg (figure) · {logo,logo-full}.svg (full art)");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
'
