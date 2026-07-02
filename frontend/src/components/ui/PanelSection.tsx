import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export interface PanelSectionProps {
  /** Stable id — set as the DOM id and reserved for future per-section state (e.g. collapse). */
  id?: string;
  /** Section heading. */
  title: ReactNode;
  /** Optional summary rendered next to the title (e.g. counts like "12 detected"). */
  meta?: ReactNode;
  /** Right-aligned slot for section-level controls — buttons, dropdowns, menus. */
  actions?: ReactNode;
  /** Drop the default body padding (when a child manages its own spacing). */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * One region inside a {@link WorkbenchPanel}: a consistent header row (title + optional summary
 * + a right-aligned actions slot) over a body. Every editor feature renders into this so the
 * sections share header anatomy, spacing, and a single place to hang future controls. Kept
 * purely presentational — collapse/persistence can layer on later via `id` without touching
 * the call sites.
 */
export function PanelSection({
  id,
  title,
  meta,
  actions,
  flush,
  className,
  children,
}: PanelSectionProps) {
  return (
    <section id={id} className={cn("flex flex-col", className)}>
      <header className="flex items-center gap-3 px-5 py-3">
        <h2 className="font-serif text-lg">{title}</h2>
        {meta ? <span className="text-sm text-text-tertiary">{meta}</span> : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn(!flush && "px-5 pb-5")}>{children}</div>
    </section>
  );
}
