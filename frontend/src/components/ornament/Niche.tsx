import { cn } from "@/lib/cn";
import { pointedArchPath } from "@/ornament/arch";
import { thumbBars } from "@/ornament/waveformThumb";
import { useMemo } from "react";

const BODY = pointedArchPath({ width: 300, height: 400 });
const INNER = pointedArchPath({ width: 300, height: 400, inset: 11 });

export interface NicheProps {
  /** Draws the current-recording variant (accent fill, gold line). */
  current?: boolean;
  /** Seeds the decorative waveform (e.g. the project id); omit for an empty niche. */
  seed?: string | number;
  className?: string;
}

/**
 * Mihrab niche: the pointed-arch card background with its inner gold line and an optional
 * decorative waveform. Stretches to fill its container; strokes keep a constant width.
 */
export function Niche({ current = false, seed, className }: NicheProps) {
  const bars = useMemo(() => (seed === undefined ? null : thumbBars(seed)), [seed]);
  return (
    <svg
      viewBox="0 0 300 400"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={cn("orn-niche", current && "current", className)}
    >
      <path className="n-body" d={BODY} />
      <path className="n-inner" d={INNER} />
      {bars && (
        <g className="n-wave">
          {bars.map((b) => (
            <rect key={b.x} x={b.x} y={b.y} width={b.width} height={b.height} rx={b.width / 2} />
          ))}
        </g>
      )}
    </svg>
  );
}
