import { useId } from "react";

/** A per-instance id safe inside SVG `url(#…)` references (React's `:r0:` form, colons stripped). */
export function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
