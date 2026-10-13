import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useId, useState } from "react";

export type TooltipSide = "top" | "bottom" | "right";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
}

const SIDES: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
};

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
            "pointer-events-none absolute z-40 whitespace-nowrap rounded bg-text px-2 py-1 text-xs text-background shadow-md",
            SIDES[side],
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
