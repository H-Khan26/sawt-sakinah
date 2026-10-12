import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";
import { WaveformLoader } from "./WaveformLoader";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dome";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner and disable the button while an action is in flight. */
  loading?: boolean;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded font-sans font-medium " +
  "transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** Focus ring for buttons on the page; `dome` sets its own for the dome ground. */
const PAGE_RING = "focus-visible:ring-border-focus focus-visible:ring-offset-background";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: `bg-accent text-accent-on hover:bg-accent-hover ${PAGE_RING}`,
  secondary: `border border-border bg-surface text-text hover:bg-background-secondary ${PAGE_RING}`,
  ghost: `bg-transparent text-accent hover:bg-accent-soft ${PAGE_RING}`,
  danger: `bg-danger text-accent-on hover:brightness-95 ${PAGE_RING}`,
  /** Outlined icon button for the header on the dome ground. */
  dome:
    "border border-dome-on/40 bg-transparent text-dome-on hover:bg-dome-on/10 " +
    "focus-visible:ring-dome-on focus-visible:ring-offset-dome",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading && <WaveformLoader size={size === "sm" ? 12 : 14} bars={4} />}
      {children}
    </button>
  );
});
