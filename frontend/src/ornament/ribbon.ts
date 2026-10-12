import { num } from "./num.ts";

/** Bookmark ribbon filling a `width`×`height` box, its foot cut by a V-notch rising to `notch`·height. */
export function ribbonTabPath({
  width,
  height,
  notch = 0.82,
}: {
  width: number;
  height: number;
  notch?: number;
}): string {
  return `M0 0 H${num(width)} V${num(height)} L${num(width / 2)} ${num(notch * height)} L0 ${num(height)} Z`;
}
