import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible content: text, or an icon paired with `ariaLabel`. */
  label: ReactNode;
  /** Accessible name when `label` is not text. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A row of mutually exclusive choices on a sunk track; the chosen segment fills with the accent.
 * Each segment is a toggle button (`aria-pressed`) inside a fieldset named by `label`.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  return (
    <fieldset
      disabled={disabled}
      className={cn(
        "inline-flex min-w-0 rounded border border-border bg-background-secondary p-[3px]",
        disabled && "opacity-50",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-1.5 text-[13px] font-medium",
              "transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
              "disabled:cursor-not-allowed",
              selected ? "bg-accent text-accent-on" : "text-text-secondary hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
