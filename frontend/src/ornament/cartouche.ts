import { num } from "./num.ts";

/**
 * Sura cartouche filling a `width`×`height` box: a straight body between two bracket ends whose
 * reach is 0.84·height, so the body stretches with the width while the ends keep their shape.
 * A 236×50 box gives the spec's 264×150 outer shape shifted by (−14, −50). `inset` gives the inner line.
 */
export function cartouchePath({
  width,
  height,
  inset = 0,
}: {
  width: number;
  height: number;
  inset?: number;
}): string {
  const h = height - 2 * inset;
  const top = inset;
  const mid = height / 2;
  const bottom = height - inset;
  const tipL = 2 * inset;
  const tipR = width - 2 * inset;
  const bodyL = tipL + 0.84 * h;
  const bodyR = tipR - 0.84 * h;
  // Bracket controls: 0.32·h out from the tip along the midline, 0.4·h out from the body corner.
  const t = 0.32 * h;
  const b = 0.4 * h;
  const p = (x: number, y: number) => `${num(x)} ${num(y)}`;
  return (
    `M${p(tipL, mid)} C${p(tipL + t, mid)} ${p(bodyL - b, top)} ${p(bodyL, top)} ` +
    `L${p(bodyR, top)} C${p(bodyR + b, top)} ${p(tipR - t, mid)} ${p(tipR, mid)} ` +
    `C${p(tipR - t, mid)} ${p(bodyR + b, bottom)} ${p(bodyR, bottom)} ` +
    `L${p(bodyL, bottom)} C${p(bodyL - b, bottom)} ${p(tipL + t, mid)} ${p(tipL, mid)} Z`
  );
}
