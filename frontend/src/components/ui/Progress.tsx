import { cn } from "@/lib/cn";
import { WaveformLoader } from "./WaveformLoader";

export interface ProgressProps {
  /** 0..1 for a determinate bar; omit (or null) for an indeterminate animation. */
  value?: number | null;
  className?: string;
  label?: string;
}

/**
 * Linear progress bar. Determinate when `value` is a number in [0,1]; otherwise an
 * indeterminate sliding indicator (stilled under `prefers-reduced-motion`).
 */
export function Progress({ value, className, label = "Progress" }: ProgressProps) {
  const isDeterminate = typeof value === "number" && Number.isFinite(value);
  const pct = isDeterminate ? Math.min(100, Math.max(0, value * 100)) : undefined;

  // Indeterminate: a speaking-waveform loader instead of a track + sliding sweep. The
  // loader itself is an `<output>` (implicit status role) carrying the label, so the
  // wrapper stays a plain layout box: an indeterminate progressbar has no value to
  // expose, which is what the progressbar role exists to convey.
  if (!isDeterminate) {
    return (
      <div className={cn("flex h-6 w-full items-center justify-center", className)}>
        <WaveformLoader size={22} label={label} className="text-accent" />
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: a progressbar is a status role, not a keyboard widget, so it isn't in the tab order.
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct as number)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-background-tertiary", className)}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-normal"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
