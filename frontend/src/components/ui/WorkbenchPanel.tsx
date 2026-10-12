import { cn } from "@/lib/cn";
import type { HTMLAttributes } from "react";

/**
 * The editor's single elevated surface. Direct children are stacked seamlessly (typically
 * {@link PanelSection}s, plus the transport toolbar and header row), so the whole workbench
 * reads as one contiguous block on a solid surface rather than a set of separate cards. Section
 * spacing comes from each region's own padding, not hard dividers. New regions are added simply
 * by dropping another child in.
 */
export function WorkbenchPanel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-border",
        "bg-surface shadow-lg",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
