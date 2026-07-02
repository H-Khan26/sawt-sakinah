import { cn } from "@/lib/cn";
import type { HTMLAttributes } from "react";

/**
 * The editor's single elevated surface. Direct children are stacked and separated by hairline
 * dividers (typically {@link PanelSection}s, plus the transport toolbar and header row), so the
 * whole workbench reads as one contiguous block lifted off the patterned background rather than
 * a set of separate cards.
 *
 * The solid `bg-background-secondary` occludes the ogee wallmark; `shadow-xl` + the faint ring
 * supply the depth that distinguishes the block from the busy backdrop. New regions are added
 * simply by dropping another child in — they inherit the seams and the elevation for free.
 */
export function WorkbenchPanel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border",
        "bg-background-secondary shadow-xl ring-1 ring-black/5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
