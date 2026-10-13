import { cn } from "@/lib/cn";
import { cartouchePath } from "@/ornament/cartouche";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

export interface CartoucheProps {
  children: ReactNode;
  className?: string;
}

/**
 * Sura cartouche behind a title: lacquer fill (`--cartouche-fill`) with a gold outer line and a
 * 0.6 px inner line.
 * Sizes to its content (360 px minimum, 60% maximum) and redraws the shape at its measured size,
 * so the bracket ends keep their proportion while the body stretches.
 */
export function Cartouche({ children, className }: CartoucheProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      setBox((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn("orn-cartouche", className)}>
      {box && box.width > 0 && box.height > 0 && (
        <svg viewBox={`0 0 ${box.width} ${box.height}`} aria-hidden="true" focusable="false">
          <path className="c-body" d={cartouchePath(box)} />
          <path className="c-inner" d={cartouchePath({ ...box, inset: 5 })} />
        </svg>
      )}
      <span className="orn-cartouche-content">{children}</span>
    </div>
  );
}
