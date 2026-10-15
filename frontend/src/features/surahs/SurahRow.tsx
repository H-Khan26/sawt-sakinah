/**
 * One surah in the Surahs column: its number in the star medallion, its Arabic name (Amiri) over
 * its transliteration, and on the right its ayah range (with "complete" when every ayah was
 * heard, or "recited N×" for Al-Fatihah) over its passage count and total length. An "Unsure"
 * flag marks a surah with unsure passages.
 *
 * The selected row opens: the two actions, which act on the accepted passages only, then a chip
 * per passage (its time on the edited timeline and its ayat; a chip seeks there). A surah
 * whose passages are all unsure keeps them disabled with a hint to listen first. However it was
 * selected (the row, the band, `[` / `]`), the row scrolls to the top of the column, so its
 * actions show. While Al-Fatihah is hidden its row collapses to one quiet line.
 */
import { RubElHizb } from "@/components/ornament";
import { Button } from "@/components/ui";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { formatHms } from "@/lib/time";
import type { SurahInfo, SurahPassage } from "@/types/api";
import { useEffect, useRef } from "react";
import { FATIHAH, type SurahGroup, ayahRange, surahName } from "./surahModel";

/**
 * Scroll `el` to the top of its nearest scrolling ancestor (the Surahs column), and nothing
 * else: unlike `scrollIntoView`, the page and the editor never move. A column that isn't
 * scrolling (the page grows instead) is left as is.
 */
function scrollToColumnTop(el: HTMLElement) {
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box || box.scrollHeight <= box.clientHeight) return;
  box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

/** The amber "Unsure" flag. */
export function UnsureFlag({ children = "Unsure" }: { children?: string }) {
  return (
    <span className="inline-block rounded-full bg-warning/10 px-2 py-px text-[10.5px] uppercase tracking-[0.1em] text-warning">
      {children}
    </span>
  );
}

export function SurahRow({
  group,
  infos,
  selected,
  hidden,
  onSelect,
  onSeek,
  onKeepOnly,
  onNewRecording,
}: {
  group: SurahGroup;
  infos: ReadonlyMap<number, SurahInfo> | undefined;
  selected: boolean;
  /** Al-Fatihah while it is hidden: one quiet line, not selectable. */
  hidden: boolean;
  onSelect: () => void;
  onSeek: (passage: SurahPassage) => void;
  onKeepOnly: () => void;
  onNewRecording: () => void;
}) {
  const { timeMap } = useWaveformContext();
  const info = infos?.get(group.surah);
  const name = surahName(group.surah, infos);
  const count = group.passages.length;
  const unsure = count - group.accepted.length;
  const isFatihah = group.surah === FATIHAH;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected && ref.current) scrollToColumnTop(ref.current);
  }, [selected]);

  if (hidden) {
    return (
      <li className="flex items-center gap-2.5 border-b border-border px-1.5 py-1 text-sm text-text-tertiary">
        <RubElHizb numeral={group.surah} size={24} className="opacity-60" />
        <span>
          {name} hidden · recited {count}×
        </span>
      </li>
    );
  }

  const range = `Ayat ${ayahRange(group.ayahFrom, group.ayahTo)}`;
  const meta = isFatihah
    ? `${range} · recited ${count}×`
    : `${range}${group.complete ? " · complete" : ""}`;

  return (
    <li ref={ref} className={cn("border-b border-border", selected && "bg-accent-soft")}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 px-1.5 py-1.5 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus",
          !selected && "hover:bg-background-secondary",
        )}
      >
        <RubElHizb numeral={group.surah} size={30} filled={selected} />
        <span className="flex min-w-0 flex-col">
          <span
            lang="ar"
            dir="rtl"
            className="self-start font-arabic-display text-[19px] leading-tight text-text"
          >
            {info?.name ?? name}
          </span>
          <span
            className={cn(
              "truncate font-display text-[14px] leading-tight",
              selected ? "text-accent" : "text-text-secondary",
            )}
          >
            {name}
          </span>
        </span>
        <span className="flex flex-col items-end gap-0.5 text-right text-xs leading-snug tabular-nums text-text-secondary">
          <span>{meta}</span>
          <span>
            {plural(count, "passage", "passages")} · {formatHms(group.length)}
          </span>
          {unsure > 0 && (
            <UnsureFlag>{unsure === count ? "Unsure" : `${unsure} unsure`}</UnsureFlag>
          )}
        </span>
      </button>

      {selected && (
        <div className="flex flex-col gap-2.5 pb-3 pl-[46px] pr-1.5 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onKeepOnly} disabled={group.accepted.length === 0}>
              Keep only this surah
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onNewRecording}
              disabled={group.accepted.length === 0}
            >
              New recording…
            </Button>
          </div>
          {group.accepted.length === 0 ? (
            <p className="text-xs text-text-tertiary">
              Listen first: every passage of this surah is unsure, so it can't be kept or copied.
            </p>
          ) : (
            unsure > 0 && (
              <p className="text-xs text-text-tertiary">
                These act on the {plural(group.accepted.length, "sure passage", "sure passages")}{" "}
                only.
              </p>
            )
          )}
          <ul aria-label={`${name} passages`} className="flex flex-wrap gap-1.5">
            {group.passages.map((p) => (
              <li key={p.start}>
                <button
                  type="button"
                  title="Play from here"
                  onClick={() => onSeek(p)}
                  className={cn(
                    "rounded-full border bg-surface px-2.5 py-0.5 text-xs tabular-nums text-text-secondary",
                    "hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
                    p.level === "unsure" ? "border-dashed border-warning" : "border-border",
                  )}
                >
                  {formatHms(timeMap.toEdited(p.start))} · {ayahRange(p.ayah_from, p.ayah_to)}
                  {p.level === "unsure" && " · unsure"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
