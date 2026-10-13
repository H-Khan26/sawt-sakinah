import { num } from "./num.ts";

/** One decorative bar in the 300×400 niche box. */
export interface ThumbBar {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LCG_M = 233280;

/** Tallest bar and the bars' centre line, in the 300×400 niche box. */
const MAX_HEIGHT = 100;
const CENTRE_Y = 170;

/** Hashes a string to a non-negative integer (FNV-1a, 32 bit). */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic decorative waveform for a niche: `n` bars between x = 72 and 228.2, at most 100 tall
 * (a quarter of the niche) and centred on y = 170, a little above the middle. Driven by the spec's
 * LCG, so the same seed (e.g. a project id) always draws the same bars.
 */
export function thumbBars(seed: string | number, n = 36): ThumbBar[] {
  const start = typeof seed === "string" ? hashSeed(seed) : Math.trunc(seed);
  let s = ((start % LCG_M) + LCG_M) % LCG_M;
  // 36 bars sit 4.4 apart, as in the spec; other counts share the same run.
  const step = 158.4 / n;
  const bars: ThumbBar[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % LCG_M;
    const v = 0.25 + 0.75 * (s / LCG_M) * (0.55 + 0.45 * Math.sin((i / n) * Math.PI * 2.2 + 1));
    bars.push({
      x: Number(num(72 + i * step)),
      y: Number(num(CENTRE_Y - v * (MAX_HEIGHT / 2))),
      width: Number(num(step / 2)),
      height: Number(num(v * MAX_HEIGHT)),
    });
  }
  return bars;
}
