import { CetvelFrame } from "@/components/ornament";
import { cn } from "@/lib/cn";
import type { ReactNode, RefObject } from "react";
import { useLayoutEffect, useRef, useState } from "react";

/** The main area must be at least this tall for the page to fit it without scrolling. */
const FIT_MIN_HEIGHT = 760;

/**
 * Whether the element's scroll parent (the editor's main area) is tall enough for the fixed
 * page, tracked with a `ResizeObserver`.
 */
function useParentFits(ref: RefObject<HTMLElement>, minHeight: number): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setFits(parent.clientHeight >= minHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref, minHeight]);
  return fits;
}

/**
 * The editor's ruled page: a surface sheet whose edge is the cetvel double rule, set ~20 px
 * inside the main area with no shadow. When the main area is at least 760 px tall the page
 * fills it exactly (`is-fit`), so rows inside can size to it with `group-[.is-fit]/page:`
 * variants and the lower band scrolls internally; below that the page grows and the main area
 * scrolls. `centered` holds a single block (progress, errors) in the middle of the page.
 */
export function RuledPage({
  children,
  centered = false,
  className,
}: {
  children: ReactNode;
  centered?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fits = useParentFits(ref, FIT_MIN_HEIGHT);
  return (
    <div
      ref={ref}
      className={cn("group/page flex min-h-full flex-col p-5", fits && "is-fit h-full")}
    >
      <CetvelFrame
        className="flex min-h-0 flex-1 flex-col bg-surface"
        innerClassName={cn(
          "min-h-0 flex-1",
          centered ? "flex items-center justify-center p-8" : className,
        )}
      >
        {children}
      </CetvelFrame>
    </div>
  );
}
