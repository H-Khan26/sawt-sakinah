import { domeAngle } from "./dome.ts";
import { clamp, ease, lerp, smooth } from "./ease.ts";
import { num } from "./num.ts";

/** The outer of Çamlıca's three rings: radius 0.80·R with 32 lamps. */
export const LAMP_RING = { f: 0.8, n: 32 } as const;

/** Width-to-height ratio of the logo artwork. */
export const LOGO_RATIO = 2.403;

/** Angles (radians, from the top, clockwise) of `n` lamps, shifted by `offset` divisions. */
export function lampAngles(n: number, offset = 0.5): number[] {
  return Array.from({ length: n }, (_, i) => domeAngle(i, n, offset));
}

/** Stages shorter than this keep less of the pool of light above the wall's content. */
const SHORT_STAGE = 700;

/** Sizes the descent derives from the stage: header height, dome radius and the chandelier's reach below the header. */
export function descentMetrics(width: number, height: number) {
  const headerHeight = Math.round(Math.max(92, Math.min(136, height * 0.17)));
  // Below the header: the flattened ring's half-height, the 10 px lamp drop and the pool of light.
  let chandelier = Math.round(sideRadii(width).ry + 10 + 86);
  // On short stages the reach shrinks to 12% of the height, so a row of niches shows unscrolled.
  if (height < SHORT_STAGE) chandelier = Math.min(chandelier, Math.round(height * 0.12));
  return { headerHeight, R0: Math.max(width * 0.5, height * 0.42), chandelier };
}

/** Input shared by the descent builders: scroll progress 0–1 over a `width`×`height` stage. */
export interface DescentInput {
  progress: number;
  width: number;
  height: number;
  headerHeight: number;
  /** Dome radius at the landing, in px. */
  R0: number;
  /** Swaps the two states at the midpoint with no travel. */
  reduceMotion?: boolean;
}

/** The ring's radii in side view: rx = 0.47·width, ry = 0.012·rx but at least 4 px. */
function sideRadii(width: number) {
  const rx = width * 0.47;
  return { rx, ry: Math.max(4, rx * 0.012) };
}

/** Raw and eased progress, plus the y of the band's lower edge (the header edge once descended). */
function progressOf({ progress, height, headerHeight, reduceMotion }: DescentInput) {
  const p = clamp(progress);
  const e = reduceMotion ? (p < 0.5 ? 0 : 1) : ease(p);
  return { p, e, bandY: height - p * (height - headerHeight) };
}

export interface LampRingGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  hoopFront: string;
  hoopBack: string;
  backOpacity: number;
  /** Each lamp at its angle on the ring (radians), with the cord drop below its hook. */
  lamps: { angle: number; x: number; y: number; drop: number; opacity: number }[];
  pool: { cx: number; cy: number; rx: number; ry: number; opacity: number };
  /** Lamps are visible above this y (px from the stage top). */
  lampClip: number;
}

/**
 * Lamp ring at a point of the descent: overhead under the dome, flattened onto the header's edge by
 * 60% with its back half hidden, lamps dropping 10 px and a pool of light 46 px below.
 */
export function lampRingGeometry(input: DescentInput): LampRingGeometry {
  const { width, height, R0 } = input;
  const { e, bandY } = progressOf(input);
  const side = sideRadii(width);
  const er = smooth(0, 0.6, e);
  const cx = width / 2;
  const rx = lerp(R0 * LAMP_RING.f, side.rx, er);
  const ry = lerp(R0 * LAMP_RING.f, side.ry, er);
  const cy = lerp(height / 2, bandY, er);
  const ends = `M${num(cx - rx)} ${num(cy)} A${num(rx)} ${num(ry)} 0 0 `;
  const drop = 10 * smooth(0.5, 1, e);
  return {
    cx,
    cy,
    rx,
    ry,
    hoopFront: `${ends}0 ${num(cx + rx)} ${num(cy)}`,
    hoopBack: `${ends}1 ${num(cx + rx)} ${num(cy)}`,
    backOpacity: 1 - er,
    lamps: lampAngles(LAMP_RING.n).map((a) => ({
      angle: a,
      x: cx + rx * Math.cos(a),
      y: cy + ry * Math.sin(a),
      drop,
      opacity: Math.sin(a) < 0 ? 1 - er : 1,
    })),
    pool: { cx, cy: cy + ry + 46, rx: width * 0.38, ry: 56, opacity: smooth(0.5, 1, e) },
    lampClip: bandY + smooth(0.55, 0.9, e) * height,
  };
}

export interface DescentLayout {
  /** Visible height of the dome band from the stage top. */
  bandHeight: number;
  landingOpacity: number;
  logo: {
    width: number;
    x: number;
    y: number;
  };
  dome: {
    x: number;
    y: number;
    scale: number;
    opacity: number;
    windowOpacity: number;
    bandOpacity: number;
  };
}

/**
 * Logo and dome at a point of the descent: the logo rises into the header and shrinks to fit it,
 * while the dome travels with it and dissolves from the rim inward.
 */
export function descentLayout(input: DescentInput): DescentLayout {
  const { width, height, headerHeight, R0 } = input;
  const { p, e, bandY } = progressOf(input);
  const cy = lerp(height / 2, headerHeight / 2, e);
  const lw0 = R0 * 0.5;
  const lw = lerp(lw0, Math.min(headerHeight * 1.5, width * 0.62), e);
  return {
    bandHeight: bandY,
    landingOpacity: 1 - smooth(0, 0.2, p),
    logo: {
      width: lw,
      x: width / 2 - lw / 2,
      y: cy - lw / LOGO_RATIO / 2,
    },
    dome: {
      x: width / 2,
      y: cy,
      scale: (R0 * lw) / lw0,
      opacity: 1 - smooth(0.25, 0.62, e),
      windowOpacity: 1 - smooth(0.05, 0.4, e),
      bandOpacity: 1 - smooth(0.12, 0.48, e),
    },
  };
}
