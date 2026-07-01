import { cn } from "@/lib/cn";

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

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: a progressbar is a status role, not a keyboard widget, so it isn't in the tab order.
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={isDeterminate ? 0 : undefined}
      aria-valuemax={isDeterminate ? 100 : undefined}
      aria-valuenow={isDeterminate ? Math.round(pct as number) : undefined}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-background-tertiary", className)}
    >
      {isDeterminate ? (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-normal"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="h-full w-2/5 animate-progress-indeterminate rounded-full bg-accent motion-reduce:w-1/3 motion-reduce:animate-none" />
      )}
    </div>
  );
}
