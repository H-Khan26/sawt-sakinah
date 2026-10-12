import { num } from "./num.ts";

/** Style hooks shared by the dome and lamp ring; one stylesheet maps them to the dome tokens. */
export type DomeClass =
  | "d-line"
  | "d-soft"
  | "d-win"
  | "d-fill2"
  | "ring-light"
  | "center-light"
  | "lamp"
  | "lamp-glow";

/** Gradient a primitive is filled with, by name. */
export type DomeGradientName = "ring" | "center";

/** One drawable piece of the rosette, in units of the dome radius (R = 1). */
export type DomePrimitive =
  | { kind: "circle"; r: number; cls: DomeClass; gradient?: DomeGradientName }
  | { kind: "path"; d: string; cls: DomeClass; transform?: string };

/** A radial gradient centred on the dome with radius R; `tone` names the colour role of its stops. */
export interface DomeGradient {
  name: DomeGradientName;
  tone: "window" | "line";
  stops: { offset: number; opacity: number }[];
}

/** The rosette as layered groups, so the caller can fade windows, band and the whole separately. */
export interface DomeRosette {
  gradients: DomeGradient[];
  light: DomePrimitive[];
  rims: DomePrimitive[];
  windows: DomePrimitive[];
  rings: DomePrimitive[];
  band: DomePrimitive[];
  medallion: DomePrimitive[];
}

const TAU = Math.PI * 2;

/** Window at the dome base: straight jambs with a pointed head toward the crown. */
export const DOME_WINDOW =
  "M0.97 -0.024 L0.905 -0.024 Q0.886 -0.02 0.868 0 Q0.886 0.02 0.905 0.024 L0.97 0.024 Z";

/** Radial cartouche of the 16-fold band (Çamlıca's ring of Names, left empty). */
export const DOME_CARTOUCHE =
  "M0.44 0 C0.47 -0.046 0.55 -0.046 0.58 0 C0.55 0.046 0.47 0.046 0.44 0 Z";

/** Angle of the `i`-th of `n` divisions from the top, shifted by `offset` divisions. */
export function domeAngle(i: number, n: number, offset = 0): number {
  return -Math.PI / 2 + ((i + offset) * TAU) / n;
}

const rotate = (a: number) => `rotate(${num((a * 180) / Math.PI)})`;
const ring = (r: number, cls: DomeClass): DomePrimitive => ({ kind: "circle", r, cls });
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * Builds the rosette: rims 1.0/0.975, 40 windows 0.87–0.97, 40 ribs 0.64–0.975 on half steps,
 * soft rings 0.64/0.62/0.37, 16 cartouches 0.44–0.58 and the 0.32 medallion, plus both lights.
 */
export function domeRosette(): DomeRosette {
  const windows = (cls: DomeClass) =>
    range(40).map(
      (i): DomePrimitive => ({
        kind: "path",
        d: DOME_WINDOW,
        cls,
        transform: rotate(domeAngle(i, 40)),
      }),
    );
  const ribs = range(40)
    .map((i) => {
      const a = domeAngle(i, 40, 0.5);
      const c = Math.cos(a);
      const s = Math.sin(a);
      return `M${num(0.64 * c)} ${num(0.64 * s)} L${num(0.975 * c)} ${num(0.975 * s)}`;
    })
    .join(" ");
  return {
    gradients: [
      {
        name: "ring",
        tone: "window",
        stops: [
          { offset: 0.78, opacity: 0 },
          { offset: 0.93, opacity: 0.22 },
          { offset: 1, opacity: 0 },
        ],
      },
      {
        name: "center",
        tone: "line",
        stops: [
          { offset: 0, opacity: 0.2 },
          { offset: 0.55, opacity: 0.05 },
          { offset: 1, opacity: 0 },
        ],
      },
    ],
    light: [
      { kind: "circle", r: 1, cls: "center-light", gradient: "center" },
      { kind: "circle", r: 1, cls: "ring-light", gradient: "ring" },
    ],
    rims: [ring(1, "d-line"), ring(0.975, "d-line")],
    windows: [...windows("d-win"), ...windows("d-line"), { kind: "path", d: ribs, cls: "d-soft" }],
    rings: [ring(0.64, "d-soft"), ring(0.62, "d-soft"), ring(0.37, "d-soft")],
    band: range(16).map(
      (i): DomePrimitive => ({
        kind: "path",
        d: DOME_CARTOUCHE,
        cls: "d-line",
        transform: rotate(domeAngle(i, 16)),
      }),
    ),
    medallion: [ring(0.32, "d-fill2"), ring(0.32, "d-line"), ring(0.335, "d-line")],
  };
}
