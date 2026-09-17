#!/bin/sh
# Import the OFFICIAL logo file and regenerate every app icon from it.
#
#   sh scripts/import-logo.sh /path/to/logo.png
#
# The official art (public/brand-logo-source.png) is the single source of
# truth. This script derives from its EXACT bytes:
#
#   Full square art (the complete uploaded composition):
#     favicon.svg, icon.svg, favicon-32.png, apple-touch-icon.png (180),
#     icon-192.png, icon-512.png, logo-full.svg, logo.svg
#
#   Knight figure only (a measured crop of the same file, used where the
#   full lockup would be unreadable or duplicate the HTML wordmark —
#   the nav bar and small inline marks):
#     logo-mark.svg (from logo-mark-96.png)
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

  // Full-art renders.
  const sizes = [
    ["favicon-32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["logo-render-256.png", 256],
  ];
  for (const [name, size] of sizes) {
    await sharp(src)
      .resize(size, size, { fit: "cover", position: "centre" })
      .png()
      .toFile(path.join("public", name));
  }

  // Knight-figure renders for the small mark.
  if (MARK_CROP) {
    for (const size of [96, 192]) {
      await sharp(src)
        .extract({ left: MARK_CROP.left, top: MARK_CROP.top, width: MARK_CROP.size, height: MARK_CROP.size })
        .resize(size, size)
        .png()
        .toFile(path.join("public", `logo-mark-${size}.png`));
    }
  } else {
    fs.copyFileSync("public/icon-192.png", "public/logo-mark-192.png");
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

  console.log(`imported ${src} (${meta.width}x${meta.height}) ->`);
  for (const [name] of sizes) console.log("  public/" + name);
  console.log("  public/logo-mark-{96,192}.png (knight figure)");
  console.log("  public/{favicon,icon,logo-mark,logo,logo-full}.svg (embedded)");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
'
