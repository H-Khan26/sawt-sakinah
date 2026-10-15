/**
 * The surah view on the waveform: a labelled tab for each passage in the notes margin above the
 * top rule (`SurahBand`, in `WaveformView`'s overlay slot), a translucent tint behind the bars
 * (`SurahTints`, in its underlay slot), and the same tints on the overview strip
 * (`SurahOverviewTints`). They show while the Surah view preference is on; Al-Fatihah's are left
 * out while it is hidden.
 *
 * DOM overlays, never wavesurfer regions (`useEditRegions` is the Regions plugin's single
 * owner): each passage's source edges are projected through the `TimeMap` onto the edited
 * timeline, then to x under the live zoom and scroll (`useOverlayLayout`), so they line up in
 * the collapsed and the full view alike; a passage wholly cut away in the collapsed view has no
 * width and is dropped. Neighbouring surahs alternate the gold and green tones, Al-Fatihah takes
 * the quiet tone and the selected surah the accent. A tab too narrow for its name keeps the tint
 * and names the passage in its tooltip. Clicking a tab selects its surah and seeks to the passage.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { NOTES_HEIGHT } from "@/features/waveform/layout";
import { useOverlayLayout } from "@/features/waveform/useOverlayLayout";
import { cn } from "@/lib/cn";
import { formatHms } from "@/lib/time";
import { useSurahStore } from "@/stores/surahStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { ProjectView, SurahPassage } from "@/types/api";
import { type SurahTone, ayahRange, surahName, visiblePassages } from "./surahModel";
import { useSelectSurah, useSurahGroups } from "./useSurahView";
import "./surahs.css";

/** Keep passages just off-screen so a partly-visible tab still renders. */
const OFFSCREEN_MARGIN = 48;
/** Tab widths (px) from which it shows the name, then also the ayah range. */
const NAME_MIN_PX = 48;
const RANGE_MIN_PX = 120;
/** Height of a tab; it stands on the top rule. */
const TAB_HEIGHT = 20;

interface Placed {
  passage: SurahPassage;
  tone: SurahTone | "sel";
  /** Left and right edges on the edited timeline, in seconds. */
  from: number;
  to: number;
}

/** The passages the surah view shows, each with its tone and its span on the edited timeline. */
function usePlacedPassages(project: ProjectView): Placed[] {
  const { timeMap } = useWaveformContext();
  const surahView = useViewPrefs((s) => s.surahView);
  const showFatihah = useViewPrefs((s) => s.showFatihah);
  const selected = useSurahStore((s) => s.selected);
  const { passages, groups } = useSurahGroups(project);
  if (!surahView) return [];
  const toneOf = new Map(groups.map((g) => [g.surah, g.tone]));
  return visiblePassages(passages, showFatihah)
    .map(
      (passage): Placed => ({
        passage,
        tone: passage.surah === selected ? "sel" : (toneOf.get(passage.surah) ?? "a"),
        from: timeMap.toEdited(passage.start),
        to: timeMap.toEdited(passage.end),
      }),
    )
    .filter((p) => p.to > p.from);
}

/** A passage's tooltip and accessible name, with its times on the edited timeline. */
function passageTitle(
  passage: SurahPassage,
  name: string,
  toEdited: (t: number) => number,
): string {
  const range = `ayat ${ayahRange(passage.ayah_from, passage.ayah_to)}`;
  const at = `${formatHms(toEdited(passage.start))}–${formatHms(toEdited(passage.end))}`;
  const unsure = passage.level === "unsure" ? " · unsure" : "";
  return `${name} · ${range} · ${at}${unsure}`;
}

const passageKey = (p: SurahPassage) => `${p.surah}:${p.start}`;

/** Passage tabs in the notes margin; rendered into `WaveformView`'s overlay slot. */
export function SurahBand({ project }: { project: ProjectView }) {
  const { timeMap } = useWaveformContext();
  const layout = useOverlayLayout();
  const placed = usePlacedPassages(project);
  const { infos } = useSurahGroups(project);
  const selectSurah = useSelectSurah(project);
  if (!layout || layout.pxPerSec <= 0) return null;

  return (
    <>
      {placed.map(({ passage, tone, from, to }) => {
        const x0 = from * layout.pxPerSec - layout.scrollLeft;
        const x1 = to * layout.pxPerSec - layout.scrollLeft;
        // Clipped to the viewport, so a passage scrolled half out keeps its label in view.
        const left = Math.max(x0, 0);
        const width = Math.min(x1, layout.width) - left;
        if (width <= 0) return null;
        const name = surahName(passage.surah, infos);
        const title = passageTitle(passage, name, timeMap.toEdited);
        const unsure = passage.level === "unsure";
        return (
          <button
            key={passageKey(passage)}
            type="button"
            title={title}
            aria-label={title}
            aria-pressed={tone === "sel"}
            onClick={() => selectSurah(passage.surah, passage)}
            className={cn(
              "surah-tab pointer-events-auto absolute flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-t-[3px] px-1.5 text-left",
              "font-display text-[13px] italic leading-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus",
              `surah-tone-${tone}`,
              unsure && "is-unsure",
            )}
            style={{ left, width, top: NOTES_HEIGHT - TAB_HEIGHT, height: TAB_HEIGHT }}
          >
            {width >= NAME_MIN_PX && <span className="truncate">{name}</span>}
            {width >= RANGE_MIN_PX && (
              <span className="shrink-0 font-sans text-[11px] not-italic tabular-nums opacity-80">
                {ayahRange(passage.ayah_from, passage.ayah_to)}
              </span>
            )}
            {unsure && width >= RANGE_MIN_PX && (
              <span className="shrink-0 font-sans text-[10px] uppercase not-italic tracking-[0.1em]">
                Unsure
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

/** Tints behind the bars; rendered into `WaveformView`'s underlay slot. */
export function SurahTints({ project }: { project: ProjectView }) {
  const layout = useOverlayLayout();
  const placed = usePlacedPassages(project);
  if (!layout || layout.pxPerSec <= 0) return null;
  return (
    <>
      {placed.map(({ passage, tone, from, to }) => {
        const x0 = from * layout.pxPerSec - layout.scrollLeft;
        const x1 = to * layout.pxPerSec - layout.scrollLeft;
        if (x1 < -OFFSCREEN_MARGIN || x0 > layout.width + OFFSCREEN_MARGIN) return null;
        return (
          <div
            key={passageKey(passage)}
            className={cn("surah-tint absolute inset-y-0", `surah-tone-${tone}`)}
            style={{ left: x0, width: x1 - x0 }}
          />
        );
      })}
    </>
  );
}

/** Tints on the overview strip, which spans the whole edited timeline. */
export function SurahOverviewTints({ project }: { project: ProjectView }) {
  const { timeMap } = useWaveformContext();
  const placed = usePlacedPassages(project);
  const total = timeMap.editedTotal;
  if (total <= 0) return null;
  return (
    <>
      {placed.map(({ passage, tone, from, to }) => (
        <div
          key={passageKey(passage)}
          className={cn("surah-wash absolute inset-y-0", `surah-tone-${tone}`)}
          style={{ left: `${(from / total) * 100}%`, width: `${((to - from) / total) * 100}%` }}
        />
      ))}
    </>
  );
}
