import { cn } from "@/lib/cn";
import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef, useId } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  /** Helper or error text shown below the field. */
  hint?: ReactNode;
  /** Apply the danger border/ring and mark the field aria-invalid. */
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, invalid, id, className, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-secondary">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        className={cn(
          "h-10 rounded border bg-background px-3 text-base text-text placeholder:text-text-tertiary",
          "transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
          invalid
            ? "border-danger focus-visible:ring-danger"
            : "border-border focus-visible:border-border-focus focus-visible:ring-border-focus",
          className,
        )}
        {...rest}
      />
      {hint && (
        <p id={hintId} className={cn("text-sm", invalid ? "text-danger" : "text-text-tertiary")}>
          {hint}
        </p>
      )}
    </div>
  );
});
