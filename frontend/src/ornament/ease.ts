/** Clamps `t` to the unit interval. */
export function clamp(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Interpolates linearly from `a` to `b` at `t`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep: 0 before `a`, 1 after `b`, a cubic S-curve in between. */
export function smooth(a: number, b: number, t: number): number {
  const u = clamp((t - a) / (b - a));
  return u * u * (3 - 2 * u);
}

/** Cubic ease-in-out over the unit interval. */
export function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
