/**
 * The surah view's shared state: the surah table, the project's passages grouped per surah, and
 * the selection with its seek and `[` / `]` stepping.
 *
 * Selecting a surah highlights all its passages and moves the playhead to a passage start on the
 * source timeline: from the list, its first passage; from the band, the tab's passage. `[` / `]`
 * step to the previous / next passage start the view shows (Al-Fatihah's are skipped while it is
 * hidden), selecting its surah. Escape clears the selection. The keys are ignored while typing
 * and with modifiers; Escape also keeps its meaning for the cut selection (`useEditHotkeys`).
 */
import { useSurahs } from "@/api/hooks";
import { isTypingTarget } from "@/features/cuts/useEditHotkeys";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useSurahStore } from "@/stores/surahStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { ProjectView, SurahInfo, SurahPassage } from "@/types/api";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { FATIHAH, type SurahGroup, groupSurahs, visiblePassages } from "./surahModel";

/** Seconds past a passage start within which `[` goes to the passage before it. */
const STEP_BACK_GRACE = 1;

const EMPTY: SurahPassage[] = [];

/** The surah table by number; undefined until it loads. */
export function useSurahInfos(): ReadonlyMap<number, SurahInfo> | undefined {
  const { data } = useSurahs();
  return useMemo(() => (data ? new Map(data.map((s) => [s.number, s])) : undefined), [data]);
}

/** The project's passages, grouped per surah (see `groupSurahs`). */
export function useSurahGroups(project: ProjectView): {
  passages: SurahPassage[];
  groups: SurahGroup[];
  infos: ReadonlyMap<number, SurahInfo> | undefined;
} {
  const infos = useSurahInfos();
  const passages = project.surahs?.passages ?? EMPTY;
  const groups = useMemo(() => groupSurahs(passages, infos), [passages, infos]);
  return { passages, groups, infos };
}

/** Select `surah` and seek to `passage`'s start (or the surah's first passage). */
export function useSelectSurah(project: ProjectView) {
  const { controller } = useWaveformContext();
  const select = useSurahStore((s) => s.select);
  const passages = project.surahs?.passages ?? EMPTY;
  return useCallback(
    (surah: number, passage?: SurahPassage) => {
      select(surah);
      const target = passage ?? passages.find((p) => p.surah === surah);
      if (target) controller.setSourceTime(target.start);
    },
    [select, controller, passages],
  );
}

/** `[` / `]` step through the shown passages; Escape clears the selection. Mount once. */
export function useSurahHotkeys(project: ProjectView): void {
  const { controller, timeMap } = useWaveformContext();
  const showFatihah = useViewPrefs((s) => s.showFatihah);
  const selectSurah = useSelectSurah(project);
  const passages = project.surahs?.passages ?? EMPTY;

  // Passages wholly cut away in the collapsed view have nowhere to land, so stepping skips them.
  const stops = visiblePassages(passages, showFatihah).filter(
    (p) => timeMap.identity || timeMap.toEdited(p.end) > timeMap.toEdited(p.start),
  );
  const latest = useRef({ stops, selectSurah });
  latest.current = { stops, selectSurah };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        useSurahStore.getState().select(null);
        return;
      }
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault();
      const { stops, selectSurah } = latest.current;
      const t = controller.getSourceTime();
      const target =
        e.key === "]"
          ? stops.find((p) => p.start > t + 1e-3)
          : [...stops].reverse().find((p) => p.start < t - STEP_BACK_GRACE);
      if (target) selectSurah(target.surah, target);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);
}

/** Clear a selected Al-Fatihah while it is hidden, since nothing shows it. */
export function useHiddenFatihahDeselect(): void {
  const showFatihah = useViewPrefs((s) => s.showFatihah);
  useEffect(() => {
    if (!showFatihah && useSurahStore.getState().selected === FATIHAH) {
      useSurahStore.getState().select(null);
    }
  }, [showFatihah]);
}
