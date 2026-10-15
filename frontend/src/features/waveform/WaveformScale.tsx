/**
 * The level scale at the waveform's right edge: the level of full height in dBFS, with ticks at
 * half and quarter height. The bars are linear in amplitude, so those sit 6 and 12 dB below full
 * height. The scale is fixed per recording (see `service/waveform.py`), which the tooltip on the
 * top label says, so editors don't read it as a universal level. It renders beneath the overlay
 * layer, so the surah band and seam chips stay on top.
 */
import { Tooltip } from "@/components/ui";
import { WAVE_HEIGHT } from "./layout";

/** Fractions of full height that carry a tick. */
const TICKS = [0.5, 0.25];

/** Round to whole dB with a typographic minus. */
function formatDb(db: number): string {
  const v = Math.round(db);
  return v < 0 ? `−${-v}` : String(v);
}

/** Distance (px) from the top rule to the bar height `fraction` of full height. */
function tickTop(fraction: number): number {
  return (1 - fraction) * (WAVE_HEIGHT / 2);
}

const LABEL =
  "whitespace-nowrap rounded-sm bg-surface/80 px-1 text-[11px] leading-4 text-text-tertiary tabular-nums";

export function WaveformScale({ scaleDb, top }: { scaleDb: number; top: number }) {
  return (
    <div
      className="pointer-events-none absolute right-0 z-20"
      style={{ top, height: WAVE_HEIGHT / 2 }}
    >
      <div className="absolute right-0 top-0.5">
        <Tooltip
          side="left"
          content={`Scaled to this recording: full height is ${formatDb(scaleDb)} dBFS RMS. Other recordings use their own scale.`}
        >
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the tooltip is reachable by keyboard.
            tabIndex={0}
            className={`${LABEL} pointer-events-auto cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus`}
          >
            {formatDb(scaleDb)} dB
          </span>
        </Tooltip>
      </div>
      {TICKS.map((fraction) => (
        <div
          key={fraction}
          aria-hidden="true"
          className="absolute right-0 flex -translate-y-1/2 items-center gap-1"
          style={{ top: tickTop(fraction) }}
        >
          <span className={LABEL}>{formatDb(scaleDb + 20 * Math.log10(fraction))}</span>
          <span className="h-px w-1.5 bg-text-tertiary" />
        </div>
      ))}
    </div>
  );
}
