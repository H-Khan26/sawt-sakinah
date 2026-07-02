/**
 * Hex mirrors of the waveform-related CSS custom properties in `src/index.css`.
 *
 * wavesurfer draws to a `<canvas>` and cannot resolve CSS custom properties, so the
 * palette is duplicated here as literal values. **Keep these in sync with the
 * `--waveform-*` / `--silence-*` / `--marker-*` tokens** — they are the same colors, split
 * across two representations only because canvas can't read the vars.
 */
export const waveformColors = {
  /** Played portion + cursor. Mirrors `--waveform-played` / `--color-accent`. */
  played: "#450377",
  /** Unplayed portion. Mirrors `--waveform-unplayed`. */
  unplayed: "#cbd5e1",
  /** Playback cursor. Mirrors `--waveform-cursor`. */
  cursor: "#450377",
  /** Hover-scrub line + label. Mirrors `--color-accent-secondary`. */
  hover: "#9667ba",
} as const;

/** Silence-region palette (consumed in Phase 5). Mirrors the `--silence-*` tokens. */
export const silenceColors = {
  fill: "rgba(150, 103, 186, 0.18)",
  fillSelected: "rgba(150, 103, 186, 0.38)",
  barSelected: "#450377",
} as const;

/**
 * Manual-cut region palette (red, derived from `--color-error` #ef4444). Committed cuts
 * that don't correspond to a detected silence render in this color. Mirrors `--cut-*`.
 */
export const cutColors = {
  fill: "rgba(239, 68, 68, 0.20)",
  fillSelected: "rgba(239, 68, 68, 0.40)",
} as const;

/**
 * Pending in/out selection palette (gold, derived from `--color-warning` #f59e0b). The
 * not-yet-committed cut range renders in this color. Mirrors `--selection-fill`.
 */
export const selectionColors = {
  fill: "rgba(245, 158, 11, 0.30)",
} as const;

/** Marker palette (consumed in Phase 6). Mirrors `--marker-line`. */
export const markerColors = {
  line: "#450377",
} as const;
