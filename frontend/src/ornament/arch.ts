// Imports carry the `.ts` extension so `scripts/icons.ts` can load this file under plain Node.
import { num } from "./num.ts";

/** A two-centred arch between two jambs, its arc centres `offset` past the midline. */
export interface TwoCentredArch {
  left: number;
  right: number;
  /** Springing line: the y where the jambs turn into arcs. */
  spring: number;
  /** Foot of the jambs. */
  bottom: number;
  /** Distance of each arc centre past the midline; the radius is half the span plus this. */
  offset: number;
  /** Closes the path along the foot; open paths suit stroked inner lines. */
  closed?: boolean;
}

/** Builds the path of a two-centred pointed arch from foot to apex to foot. */
export function twoCentredArchPath({
  left,
  right,
  spring,
  bottom,
  offset,
  closed = true,
}: TwoCentredArch): string {
  const r = (right - left) / 2 + offset;
  const apex = spring - Math.sqrt(r * r - offset * offset);
  const arc = `A${num(r)} ${num(r)} 0 0 1`;
  return (
    `M${num(left)} ${num(bottom)} V${num(spring)} ${arc} ${num((left + right) / 2)} ${num(apex)} ` +
    `${arc} ${num(right)} ${num(spring)} V${num(bottom)}${closed ? " Z" : ""}`
  );
}

/** Springing line of the niche arch as a fraction of the box height (215 of 400). */
const NICHE_SPRING = 215 / 400;

/**
 * Sivri kemer filling a `width`×`height` box: centres 0.2·span past the midline, radius 0.7·span.
 * `inset` gives the concentric inner line, left open at the foot like the spec's `ARCH_IN`.
 */
export function pointedArchPath({
  width,
  height,
  inset = 0,
}: {
  width: number;
  height: number;
  inset?: number;
}): string {
  return twoCentredArchPath({
    left: inset,
    right: width - inset,
    spring: height * NICHE_SPRING,
    bottom: height,
    offset: 0.2 * width,
    closed: inset === 0,
  });
}

/** A rounded bar in icon units. */
export interface IconBar {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

/** App icon arch in its 100×100 tile; `inset` gives the concentric gold hairline. */
export function iconArchPath(inset = 0): string {
  return twoCentredArchPath({
    left: 24 + inset,
    right: 76 - inset,
    spring: 46,
    bottom: 86 - inset,
    offset: 4,
  });
}

/** The app icon's three waveform bars in its 100×100 tile. */
export const ICON_BARS: readonly IconBar[] = [
  { x: 33, y: 52, width: 7, height: 22, rx: 3.5 },
  { x: 46.5, y: 38, width: 7, height: 44, rx: 3.5 },
  { x: 60, y: 52, width: 7, height: 22, rx: 3.5 },
];

/** Tileless mark arch (favicon and small icon sizes) in a 100×118 box; `inset` gives the inner arch. */
export function markArchPath(inset = 0): string {
  return twoCentredArchPath({
    left: 8 + inset,
    right: 92 - inset,
    spring: 52,
    bottom: 116 - inset,
    offset: 8,
  });
}

/** The mark's three waveform bars (48 and 32 px) in its 100×118 box. */
export const MARK_BARS: readonly IconBar[] = [
  { x: 29, y: 64, width: 9, height: 28, rx: 4.5 },
  { x: 45.5, y: 46, width: 9, height: 62, rx: 4.5 },
  { x: 62, y: 64, width: 9, height: 28, rx: 4.5 },
];

/** The mark's single bar at 16 px, in its 100×118 box. */
export const MARK_SINGLE_BAR: IconBar = { x: 38, y: 38, width: 24, height: 64, rx: 12 };
