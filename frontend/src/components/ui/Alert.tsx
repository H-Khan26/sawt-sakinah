import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { Button } from "./Button";

export type AlertVariant = "error" | "success" | "warning" | "info";

export interface AlertProps {
  variant?: AlertVariant;
  title?: ReactNode;
  children?: ReactNode;
  /** Label + handler for an optional action button (e.g. "Retry"). */
  action?: { label: string; onClick: () => void; loading?: boolean };
  className?: string;
}

/** Border + soft tint per semantic color. Kept in sync with the Toast variants. */
const VARIANTS: Record<AlertVariant, { wrap: string; title: string }> = {
  error: { wrap: "border-danger/40 bg-danger/5", title: "text-danger" },
  success: { wrap: "border-success/40 bg-success/5", title: "text-success" },
  warning: { wrap: "border-warning/40 bg-warning/5", title: "text-warning" },
  info: { wrap: "border-info/40 bg-info/5", title: "text-info" },
};

export function Alert({ variant = "info", title, children, action, className }: AlertProps) {
  const styles = VARIANTS[variant];
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn("rounded border p-4", styles.wrap, className)}
    >
      {title && <p className={cn("font-medium", styles.title)}>{title}</p>}
      {children && (
        <div className={cn("text-sm text-text-secondary", title ? "mt-1" : undefined)}>
          {children}
        </div>
      )}
      {action && (
        <div className="mt-3">
          <Button size="sm" variant="secondary" loading={action.loading} onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
