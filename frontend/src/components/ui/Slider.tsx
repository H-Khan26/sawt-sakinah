import { cn } from "@/lib/cn";
import { useId } from "react";

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

/** Single-thumb slider. Native range input styled to the accent token. */
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
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <label htmlFor={id}>{label}</label>
          <span className="tabular-nums text-text">{format ? format(value) : value}</span>
        </div>
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
        className="accent-accent h-2 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

export interface RangeSliderProps extends CommonProps {
  value: [number, number];
  onChange: (value: [number, number]) => void;
}

/**
 * Two-thumb range slider built from two overlaid native inputs plus a filled track.
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
  const span = max - min || 1;
  const loPct = ((lo - min) / span) * 100;
  const hiPct = ((hi - min) / span) * 100;

  const setLo = (v: number) => onChange([Math.min(v, hi), hi]);
  const setHi = (v: number) => onChange([lo, Math.max(v, lo)]);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>{label}</span>
          <span className="tabular-nums text-text">
            {format ? `${format(lo)} – ${format(hi)}` : `${lo} – ${hi}`}
          </span>
        </div>
      )}
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-background-tertiary" />
        <div
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent"
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
          className="pointer-events-none absolute inset-0 h-5 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto"
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
          className="pointer-events-none absolute inset-0 h-5 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto"
        />
      </div>
    </div>
  );
}
