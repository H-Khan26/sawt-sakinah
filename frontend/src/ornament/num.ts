/** Formats a coordinate for SVG path data, rounded to `digits` decimals with no `-0`. */
export function num(n: number, digits = 3): string {
  const k = 10 ** digits;
  return String(Math.round(n * k) / k || 0);
}
