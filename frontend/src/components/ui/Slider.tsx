import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";
import { useId } from "react";
import "./slider.css";

interface CommonProps {
  min: number;
  max: number;
  step?: number;
  label?: string;
  /** Format a raw value for the readout (e.g. `(v) => `${v} dB``). */
  format?: (value: number) => string;
  disabled?: boolean;
  className?: string;
}

export interface SliderProps extends CommonProps {
  value: number;
  onChange: (value: number) => void;
}

/** Field label row: the name in small tracked capitals, the formatted value on the right. */
function SliderLabel({
  htmlFor,
  label,
  value,
}: { htmlFor?: string; label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-xs uppercase tracking-[0.16em] text-text-tertiary">
        {label}
      </label>
      <span className="whitespace-nowrap text-sm tabular-nums text-text">{value}</span>
    </div>
  );
}

const percent = (value: number, min: number, max: number): number =>
  ((value - min) / (max - min || 1)) * 100;

/** Single-thumb slider: a native range input with a hairline track and a diamond thumb. */
export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  label,
  format,
  disabled,
  className,
}: SliderProps) {
  const id = useId();
  const fill = { "--fill": `${percent(value, min, max)}%` } as CSSProperties;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <SliderLabel htmlFor={id} label={label} value={format ? format(value) : `${value}`} />
      )}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-diamond"
        style={fill}
      />
    </div>
  );
}

export interface RangeSliderProps extends CommonProps {
  value: [number, number];
  onChange: (value: [number, number]) => void;
}

/**
 * Two-thumb range slider built from two overlaid native inputs plus a drawn track.
 * The lower thumb is clamped below the upper and vice-versa on change.
 */
export function RangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  label,
  format,
  disabled,
  className,
}: RangeSliderProps) {
  const [lo, hi] = value;
  const loPct = percent(lo, min, max);
  const hiPct = percent(hi, min, max);

  const setLo = (v: number) => onChange([Math.min(v, hi), hi]);
  const setHi = (v: number) => onChange([lo, Math.max(v, lo)]);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <SliderLabel
          label={label}
          value={format ? `${format(lo)} – ${format(hi)}` : `${lo} – ${hi}`}
        />
      )}
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-background-tertiary" />
        <div
          className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-accent"
          style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
        />
        <input
          type="range"
          aria-label={label ? `${label} minimum` : "minimum"}
          min={min}
          max={max}
          step={step}
          value={lo}
          disabled={disabled}
          onChange={(e) => setLo(Number(e.target.value))}
          className="range-diamond range-pair"
        />
        <input
          type="range"
          aria-label={label ? `${label} maximum` : "maximum"}
          min={min}
          max={max}
          step={step}
          value={hi}
          disabled={disabled}
          onChange={(e) => setHi(Number(e.target.value))}
          className="range-diamond range-pair"
        />
      </div>
    </div>
  );
}
