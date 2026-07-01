import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";
import { LoadingSpinner } from "./LoadingSpinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
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
  "focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-border bg-background text-text hover:bg-background-secondary",
  ghost: "bg-transparent text-accent hover:bg-accent-soft",
  danger: "bg-danger text-white hover:brightness-95",
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
      {loading && <LoadingSpinner size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
});
