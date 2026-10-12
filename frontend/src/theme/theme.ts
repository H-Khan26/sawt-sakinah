/**
 * Day/night theme. The stored preference (`useViewPrefs().theme`) is `system`, `day` or `night`;
 * `system` follows the OS `prefers-color-scheme`. The resolved theme is applied as
 * `data-theme="night"` on `<html>` (absent by day), which swaps the token set in `tokens.css`.
 *
 * The attribute is written synchronously whenever the preference or the OS setting changes, before
 * {@link useResolvedTheme} updates, so anything re-rendered for the new theme (e.g. canvas colours
 * read with `getComputedStyle`) already sees the new tokens. Importing this module applies the OS
 * theme straight away, ahead of the first paint; the stored preference takes over once it loads.
 */
import { useViewPrefs } from "@/stores/viewPrefs";
import type { ThemePreference } from "@/types/api";
import { create } from "zustand";

export type ResolvedTheme = "day" | "night";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function resolveTheme(theme: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (theme === "system") return systemDark ? "night" : "day";
  return theme;
}

/** The theme currently applied to `<html>`. */
export const useResolvedTheme = create<{ resolved: ResolvedTheme }>()(() => ({
  resolved: resolveTheme(useViewPrefs.getState().theme, darkQuery.matches),
}));

function applyTheme() {
  const resolved = resolveTheme(useViewPrefs.getState().theme, darkQuery.matches);
  const root = document.documentElement;
  if (resolved === "night") root.setAttribute("data-theme", "night");
  else root.removeAttribute("data-theme");
  if (useResolvedTheme.getState().resolved !== resolved) useResolvedTheme.setState({ resolved });
}

applyTheme();
darkQuery.addEventListener("change", applyTheme);
useViewPrefs.subscribe((state, prev) => {
  if (state.theme !== prev.theme) applyTheme();
});

/** The stored theme choice, the theme in effect, and a setter that persists the choice. */
export function useTheme(): {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
} {
  const theme = useViewPrefs((s) => s.theme);
  const setTheme = useViewPrefs((s) => s.setTheme);
  const resolvedTheme = useResolvedTheme((s) => s.resolved);
  return { theme, resolvedTheme, setTheme };
}
