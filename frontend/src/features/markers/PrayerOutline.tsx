/**
 * The prayer outline beside the tools: the editor's map of the recitation.
 *
 * A header ("Outline", "Rak'ah 2 of 20", previous/next), a row of Rub el Hizb stars — one per
 * rak'ah, in pairs — and the current rak'ah's positions with their start times. The current
 * rak'ah is the one holding the playhead: its star is filled, earlier ones are gold outlines and
 * later ones hairlines. A star seeks to its rak'ah's first position, a position to its start;
 * `[` and `]` step rak'ahs. Structure is server state (re-derived from the markers on every
 * edit); this only renders it, plus a gentle notice when the outline looks incomplete (never a
 * hard error; recitations vary).
 */
import { RubElHizb } from "@/components/ornament";
import { Alert, Button, Tooltip } from "@/components/ui";
import { isTypingTarget } from "@/features/cuts/useEditHotkeys";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { cn } from "@/lib/cn";
import { formatHms } from "@/lib/time";
import { usePlaybackStore } from "@/stores/playbackStore";
import type { Marker, PrayerPosition } from "@/types/api";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { DetectPhrasesButton, type PhraseDetection } from "./MarkerControls";
import { positionName } from "./names";
import { activePositionIndex } from "./structure";

/** Seconds a seek may land short of a position's start and still count as in it. */
const SEEK_TOLERANCE = 0.001;

/** A gentle, non-error notice when the derived outline looks incomplete. */
function structureNotice(markers: Marker[], structure: PrayerPosition[]): string | null {
  if (markers.length === 0) return null;
  if (structure.length <= 1) {
    return "No position changes were derived — check that the takbir markers were detected.";
  }
  if (!structure.some((p) => p.name === "tasleem")) {
    return "No closing tasleem detected; the final position runs to the end of the recording.";
  }
  return null;
}

/** `[` / `]` step to the previous / next rak'ah, outside text fields and without modifiers. */
function useRakahHotkeys(step: (delta: -1 | 1) => void) {
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        stepRef.current(e.key === "[" ? -1 : 1);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PrayerOutline({
  markers,
  structure,
  detection,
}: {
  markers: Marker[];
  structure: PrayerPosition[];
  detection: PhraseDetection;
}) {
  const { controller, timeMap } = useWaveformContext();
  // Structure and `sourceTime` are both on the source timeline, so a rak'ah whose first position
  // starts inside a cut is still found after seeking to it. The nudge absorbs a seek that lands a
  // hair before a start. The selector returns the active index, so this re-renders only when it
  // changes, not on every frame.
  const activeIndex = usePlaybackStore((s) =>
    activePositionIndex(structure, s.sourceTime + SEEK_TOLERANCE),
  );

  // Each rak'ah's positions in order; rak'ahs are numbered from 1.
  const rakahs = useMemo(() => {
    const count = structure.reduce((max, p) => Math.max(max, p.rakah), 0);
    const byRakah: PrayerPosition[][] = Array.from({ length: count }, () => []);
    for (const p of structure) byRakah[p.rakah - 1]?.push(p);
    return byRakah;
  }, [structure]);
  const count = rakahs.length;
  const current = structure.find((p) => p.index === activeIndex)?.rakah ?? 0;

  const seekRakah = (n: number) => {
    const first = rakahs[n - 1]?.[0];
    if (first) controller.setSourceTime(first.start);
  };
  const step = (delta: -1 | 1) => {
    const target = current + delta;
    if (target >= 1 && target <= count) seekRakah(target);
  };
  useRakahHotkeys(step);

  if (structure.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h2 className="font-display text-[22px] leading-none text-text">Outline</h2>
        <p className="text-sm text-text-tertiary">
          Run phrase detection to build the prayer outline.
        </p>
        <DetectPhrasesButton detection={detection} />
      </div>
    );
  }

  const notice = structureNotice(markers, structure);
  const positions = rakahs[current - 1] ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-display text-[22px] leading-none text-text">Outline</h2>
        <span className="whitespace-nowrap font-display text-[13px] uppercase tracking-[0.32em] text-text-secondary">
          Rak'ah {current} of {count}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip content="Previous rak'ah ([)">
            <Button
              size="icon"
              variant="secondary"
              onClick={() => step(-1)}
              disabled={current <= 1}
              aria-label="Previous rak'ah"
            >
              <ChevronLeft size={16} />
            </Button>
          </Tooltip>
          <Tooltip content="Next rak'ah (])">
            <Button
              size="icon"
              variant="secondary"
              onClick={() => step(1)}
              disabled={current >= count}
              aria-label="Next rak'ah"
            >
              <ChevronRight size={16} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <ol aria-label="Rak'ahs" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {Array.from({ length: Math.ceil(count / 2) }, (_, pair) => {
          const members = [pair * 2 + 1, pair * 2 + 2].filter((n) => n <= count);
          return (
            <li key={members[0]} className="flex items-center">
              {members.map((n) => {
                const start = rakahs[n - 1]?.[0]?.start ?? 0;
                const label = `Rak'ah ${n} · ${formatHms(timeMap.toEdited(start))}`;
                const state = n === current ? "current" : n < current ? "done" : "ahead";
                return (
                  <Tooltip key={n} content={label}>
                    <button
                      type="button"
                      onClick={() => seekRakah(n)}
                      aria-label={label}
                      aria-current={state === "current" ? "step" : undefined}
                      className="flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                    >
                      <RubElHizb
                        size={16}
                        filled={state === "current"}
                        className={cn(state === "ahead" && "ahead")}
                      />
                    </button>
                  </Tooltip>
                );
              })}
            </li>
          );
        })}
      </ol>

      {positions.length > 0 && (
        <ol
          aria-label={`Rak'ah ${current} positions`}
          className="grid auto-cols-[minmax(4.5rem,1fr)] grid-flow-col overflow-x-auto"
        >
          {positions.map((p) => {
            const active = p.index === activeIndex;
            return (
              <li key={p.index}>
                <button
                  type="button"
                  onClick={() => controller.setSourceTime(p.start)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 px-2.5 pt-2 text-left transition-colors duration-fast",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus",
                    active
                      ? "border-b-2 border-accent bg-accent-soft pb-[5px] text-accent"
                      : "border-b border-border pb-1.5 text-text hover:bg-background-secondary",
                  )}
                >
                  <span className="font-display text-[17px] leading-tight">
                    {positionName(p.name)}
                  </span>
                  <span
                    className={cn(
                      "text-sm tabular-nums",
                      active ? "text-accent" : "text-text-secondary",
                    )}
                  >
                    {formatHms(timeMap.toEdited(p.start))}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {notice && (
        <Alert variant="warning" title="Check the outline">
          {notice}
        </Alert>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-secondary">
          {plural(markers.length, "marker", "markers")}
        </span>
        <DetectPhrasesButton detection={detection} />
      </div>
    </div>
  );
}
