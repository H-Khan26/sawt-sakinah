import { cn } from "@/lib/cn";

export interface LoadingSpinnerProps {
  /** Diameter in pixels. */
  size?: number;
  className?: string;
  label?: string;
}

/**
 * Indeterminate spinner. Under `prefers-reduced-motion` the browser stops the CSS
 * animation (the `motion-reduce:animate-none` utility), leaving a static ring.
 */
export function LoadingSpinner({ size = 16, className, label = "Loading" }: LoadingSpinnerProps) {
  return (
    <output
      aria-label={label}
      className={cn("inline-block leading-none", className)}
      style={{ width: size, height: size }}
    >
      <svg
        className="animate-spin motion-reduce:animate-none"
        viewBox="0 0 24 24"
        fill="none"
        width={size}
        height={size}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </output>
  );
}
