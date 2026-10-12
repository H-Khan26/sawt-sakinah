import { cn } from "@/lib/cn";
import { ribbonTabPath } from "@/ornament/ribbon";
import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";

const RIBBON = ribbonTabPath({ width: 100, height: 100 });

export interface RibbonTabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Hangs the ribbon behind the label; inactive tabs are plain text. */
  active?: boolean;
}

/** Tab button whose active state hangs a bookmark ribbon (accent fill, notched foot) behind its label. */
export const RibbonTab = forwardRef<HTMLButtonElement, RibbonTabProps>(function RibbonTab(
  { active = false, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("orn-ribbon-tab", active && "active", className)}
      {...rest}
    >
      {active && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path className="r-body" d={RIBBON} />
        </svg>
      )}
      <span>{children}</span>
    </button>
  );
});
