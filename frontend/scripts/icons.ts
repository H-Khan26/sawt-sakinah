// Regenerates the favicons and the desktop app icons from the mihrab arch in src/ornament/arch.ts.
// Run with `npm run icons` (Node strips the types); the output is deterministic.
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import png2icons from "png2icons";
import {
  ICON_BARS,
  type IconBar,
  MARK_BARS,
  MARK_SINGLE_BAR,
  iconArchPath,
  markArchPath,
} from "../src/ornament/arch.ts";

// Brand colours, baked into the raster icons (the app's tokens do not reach them).
const GREEN = "#2E4A3D";
const PAPER = "#F5EFE3";
const OXBLOOD = "#6A1E28";
const TEZHIP = "#B8954F";
const GOLD = "#C9AA66";
const NIGHT = "#1B1416";

const out = (path: string) => new URL(path, import.meta.url);

const bars = (list: readonly IconBar[], fill: string) =>
  `<g fill="${fill}">${list
    .map(
      (b) => `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${b.rx}"/>`,
    )
    .join("")}</g>`;

const svg = (viewBox: string, ...parts: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${parts.join("")}</svg>\n`;

/** Full icon (72 px and up): green tile, paper arch with a gold hairline, oxblood bars. */
const fullIcon = svg(
  "0 0 100 100",
  `<rect width="100" height="100" rx="22" fill="${GREEN}"/>`,
  `<path d="${iconArchPath()}" fill="${PAPER}"/>`,
  `<path d="${iconArchPath(4.5, 4)}" fill="none" stroke="${TEZHIP}" stroke-width="1"/>`,
  bars(ICON_BARS, OXBLOOD),
);

// The tileless mark lives in a 100×118 box; a square viewBox centres it for the icon formats.
const MARK_BOX = "-9 0 118 118";

/** Mark (24–48 px and the favicon): green arch silhouette, paper inner arch, three oxblood bars. */
const mark = svg(
  MARK_BOX,
  `<path d="${markArchPath()}" fill="${GREEN}"/>`,
  `<path d="${markArchPath(12, 10)}" fill="${PAPER}"/>`,
  bars(MARK_BARS, OXBLOOD),
);

/** Smallest mark (16 px): green arch with a single gold bar. */
const markSmall = svg(
  MARK_BOX,
  `<path d="${markArchPath()}" fill="${GREEN}"/>`,
  bars([MARK_SINGLE_BAR], GOLD),
);

/** Night mark: gold outline arch and gold bars on the night ground. */
const markNight = svg(
  MARK_BOX,
  `<path d="${markArchPath(3)}" fill="${NIGHT}" stroke="${GOLD}" stroke-width="6"/>`,
  bars(MARK_BARS, GOLD),
);

/** Rasterises an SVG to a square PNG `size` px wide. */
function png(source: string, size: number): Buffer {
  const resvg = new Resvg(source, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

writeFileSync(out("../public/favicon.svg"), mark);
writeFileSync(out("../public/favicon-night.svg"), markNight);
writeFileSync(out("../public/favicon.png"), png(mark, 32));

const icoImages = [
  png(markSmall, 16),
  png(mark, 24),
  png(mark, 32),
  png(mark, 48),
  png(fullIcon, 256),
];
writeFileSync(out("../../packaging/sawt_sakinah.ico"), await pngToIco(icoImages));

const icns = png2icons.createICNS(png(fullIcon, 1024), png2icons.BICUBIC2, 0);
if (!icns) throw new Error("png2icons could not build the .icns");
writeFileSync(out("../../packaging/sawt_sakinah.icns"), icns);

console.log(
  "Wrote favicon.svg, favicon-night.svg, favicon.png, sawt_sakinah.ico, sawt_sakinah.icns",
);
