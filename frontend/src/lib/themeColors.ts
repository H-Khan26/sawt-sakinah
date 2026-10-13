/**
 * Waveform and region colours resolved from the tokens in `src/theme/tokens.css`.
 *
 * wavesurfer draws to a `<canvas>`, which cannot resolve CSS custom properties, so the values are
 * read from the computed style of `<html>` for the theme in effect. {@link useThemeColors}
 * re-reads them when the resolved theme changes; consumers re-apply them to the renderer.
 * Overlays drawn as DOM styles (the cut hatch, marker lines, the overview box) use the tokens
 * directly instead.
 */
import { type ResolvedTheme, useResolvedTheme } from "@/theme/theme";

export interface ThemeColors {
  waveformColors: {
    /** Bars before the playhead (`--waveform-played`). */
    played: string;
    /** Bars after the playhead (`--waveform-unplayed`). */
    unplayed: string;
    /** Playback cursor (`--waveform-cursor`). */
    cursor: string;
  };
  /** Detected silence bands (`--silence-fill*`). */
  silenceColors: { fill: string; fillSelected: string };
  /** The pending in/out range (`--selection-fill`). */
  selectionColors: { fill: string };
}

/** Resolve the waveform and region tokens for the theme currently applied to `<html>`. */
export function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    waveformColors: {
      played: read("--waveform-played"),
      unplayed: read("--waveform-unplayed"),
      cursor: read("--waveform-cursor"),
    },
    silenceColors: {
      fill: read("--silence-fill"),
      fillSelected: read("--silence-fill-selected"),
    },
    selectionColors: { fill: read("--selection-fill") },
  };
}

/** Resolved colours per theme; token values are fixed per theme, so one read each suffices. */
const cache = new Map<ResolvedTheme, ThemeColors>();

/**
 * The theme's waveform and region colours. Returns the same object until the resolved theme
 * changes, so it is safe as an effect dependency.
 */
export function useThemeColors(): ThemeColors {
  const resolved = useResolvedTheme((s) => s.resolved);
  let colors = cache.get(resolved);
  if (!colors) {
    colors = readThemeColors();
    // Only keep a complete read; an empty value means the stylesheet hasn't loaded yet.
    if (colors.waveformColors.played) cache.set(resolved, colors);
  }
  return colors;
}
