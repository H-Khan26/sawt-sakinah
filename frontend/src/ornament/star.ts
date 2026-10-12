import { num } from "./num.ts";

export type Point = [x: number, y: number];

/** Vertices of an 8-point star (two squares at 45°) of radius `r`, the first at angle `start`. */
export function starPoints(r: number, cx = 0, cy = 0, start = -Math.PI / 2): Point[] {
  // The two squares' edges cross at r·cos45°/cos22.5° from the centre.
  const inner = (r * Math.SQRT1_2) / Math.cos(Math.PI / 8);
  const pts: Point[] = [];
  for (let i = 0; i < 16; i++) {
    const a = start + (i * Math.PI) / 8;
    const d = i % 2 === 0 ? r : inner;
    pts.push([cx + d * Math.cos(a), cy + d * Math.sin(a)]);
  }
  return pts;
}

/** Joins points into a closed path with two-decimal coordinates. */
export function polygonPath(pts: Point[]): string {
  return `${pts.map(([x, y], i) => `${i ? "L" : "M"}${num(x, 2)} ${num(y, 2)}`).join(" ")} Z`;
}

/** Rub el Hizb star of radius `r` centred on the origin, its first point at the top. */
export function rubElHizbPath(r: number): string {
  return polygonPath(starPoints(r));
}
