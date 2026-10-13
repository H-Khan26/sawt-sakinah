import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";
import { useId } from "react";
import "./slider.css";

export interface SliderProps {
  min: number;
  max: number;
  step?: number;
  label?: string;
  /** Format a raw value for the readout (e.g. `(v) => `${v} dB``). */
  format?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  value: number;
  onChange: (value: number) => void;
}

/** Field label row: the name in small tracked capitals, the formatted value on the right. */
function SliderLabel({ htmlFor, label, value }: { htmlFor: string; label: string; value: string }) {
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
