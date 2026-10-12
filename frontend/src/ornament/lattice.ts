import { type Point, polygonPath, starPoints } from "./star.ts";

/** Side of the square lattice tile in px. */
export const LATTICE_TILE = 88;

/** The accent dot at the centre of each tile. */
export const latticeDot = { cx: 44, cy: 44, r: 2.6 } as const;

/** One tile of the 8-fold star lattice: a star of radius 44 and the four corner squares between stars. */
export function latticePath(): string {
  const h = LATTICE_TILE / 2;
  // Each corner square shares a square corner of the star, so its half-side is h − h·cos45°.
  const s = h - h * Math.SQRT1_2;
  const corners: Point[] = [
    [0, 0],
    [LATTICE_TILE, 0],
    [0, LATTICE_TILE],
    [LATTICE_TILE, LATTICE_TILE],
  ];
  const squares = corners.map(([x, y]) =>
    polygonPath([
      [x + s, y + s],
      [x - s, y + s],
      [x - s, y - s],
      [x + s, y - s],
    ]),
  );
  return [polygonPath(starPoints(h, h, h, 0)), ...squares].join(" ");
}
