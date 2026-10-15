import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useId, useState } from "react";

export type TooltipSide = "top" | "bottom" | "right" | "left";
/** Where a top or bottom tooltip lines up with its trigger. */
export type TooltipAlign = "center" | "start" | "end";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  /** Horizontal alignment of a `top` / `bottom` tooltip; `start` / `end` keep it off an edge. */
  align?: TooltipAlign;
  /** Hide the tooltip, e.g. while the trigger's own popup is open. */
  disabled?: boolean;
  className?: string;
}

const SIDES: Record<TooltipSide, string> = {
  top: "bottom-full mb-1.5",
  bottom: "top-full mt-1.5",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
};

const ALIGNS: Record<TooltipAlign, string> = {
  center: "left-1/2 -translate-x-1/2",
  start: "left-0",
  end: "right-0",
};

/**
 * CSS-positioned tooltip that appears on hover and on keyboard focus. The trigger
 * wrapper is focusable so the tooltip is reachable without a pointer; `role="tooltip"`
 * is linked via `aria-describedby`.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  disabled = false,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = open && !disabled;
  const vertical = side === "top" || side === "bottom";

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
      <span aria-describedby={shown ? id : undefined} className="inline-flex">
        {children}
      </span>
      {shown && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute z-40 whitespace-nowrap rounded bg-text px-2 py-1 text-xs text-background shadow-md",
            SIDES[side],
            vertical && ALIGNS[align],
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
