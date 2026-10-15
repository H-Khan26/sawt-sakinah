import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label beside the track; also its accessible name. */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * An on/off switch for a view setting: a small track whose knob slides right and fills green
 * when on, followed by its label. A `button` with `role="switch"` and `aria-checked`.
 */
export function Switch({ checked, onChange, children, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap rounded p-0.5 text-[13px] text-text-secondary",
        "hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors duration-fast",
          checked ? "bg-green" : "bg-background-tertiary",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-[13px] w-[13px] rounded-full bg-surface shadow-sm transition-transform duration-fast",
            checked && "translate-x-[13px]",
          )}
        />
      </span>
      {children}
    </button>
  );
}
