import { cn } from "@/lib/cn";
import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional header region (rendered above the body with a divider). */
  header?: ReactNode;
  /** Optional footer region (rendered below the body with a divider). */
  footer?: ReactNode;
  /** Drop the default body padding (useful when a child manages its own spacing). */
  flush?: boolean;
}

export function Card({ header, footer, flush, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-border bg-background-secondary shadow-sm",
        className,
      )}
      {...rest}
    >
      {header && (
        <div className="border-b border-border px-5 py-3 font-serif text-lg">{header}</div>
      )}
      <div className={cn(!flush && "p-5")}>{children}</div>
      {footer && <div className="border-t border-border px-5 py-3">{footer}</div>}
    </div>
  );
}
