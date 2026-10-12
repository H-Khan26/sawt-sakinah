import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useId, useState } from "react";

export type TooltipSide = "top" | "bottom";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
}

/**
 * CSS-positioned tooltip that appears on hover and on keyboard focus. The trigger
 * wrapper is focusable so the tooltip is reachable without a pointer; `role="tooltip"`
 * is linked via `aria-describedby`.
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {/* The trigger's focusable child (e.g. a Button) bubbles focus here, so the tooltip
          also appears on keyboard focus. `aria-describedby` links the tooltip text. */}
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded bg-text px-2 py-1 text-xs text-background shadow-md",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
