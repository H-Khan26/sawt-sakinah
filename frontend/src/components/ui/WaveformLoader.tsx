import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";

export interface WaveformLoaderProps {
  /** Height in pixels. Bar thickness and gap scale from this. */
  size?: number;
  /** Number of bars. Fewer bars (e.g. 4) read well inline; ~12 fills an overlay. */
  bars?: number;
  className?: string;
  label?: string;
}

/**
 * Deterministic per-bar peak height, as a fraction of the full height. Two overlaid
 * sines give a lively, non-repeating waveform silhouette in roughly [0.35, 1] without
 * relying on Math.random (which would jitter the layout across re-renders).
 */
function barHeight(i: number, n: number): number {
  const t = (i + 0.5) / n;
  const v = 0.55 + 0.35 * Math.sin(t * Math.PI * 3.3) + 0.1 * Math.sin(t * Math.PI * 7.1 + 1);
  return Math.min(1, Math.max(0.35, v));
}

interface BarDescriptor {
  /** Stable identity for React keys; bars never reorder, so position is the identity. */
  id: string;
  /** Peak height as a fraction of the full loader height. */
  height: number;
  /** Negative animation delay so each bar starts at a different phase of its oscillation. */
  delay: string;
}

/** Describes every bar up front so the render loop keys on data rather than a counter. */
function barDescriptors(n: number): BarDescriptor[] {
  const out: BarDescriptor[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `bar-${i}`,
      height: barHeight(i, n),
      delay: `-${(i * 0.13).toFixed(2)}s`,
    });
  }
  return out;
}

/**
 * Waveform loading animation. The bars draw in left-to-right, fluctuate up and down as
 * if someone is speaking, then draw out, on a loop (the container clip drives the draw
 * in/out reveal; each bar runs its own oscillation). Uses `currentColor`, so it inherits
 * the surrounding text color like the old spinner did — pass `text-accent` where a purple
 * waveform is wanted. Stilled to a static waveform under `prefers-reduced-motion`.
 */
export function WaveformLoader({
  size = 24,
  bars = 12,
  className,
  label = "Loading",
}: WaveformLoaderProps) {
  const barWidth = Math.max(2, Math.round(size / 8));
  const gap = Math.max(2, Math.round(barWidth * 0.7));

  return (
    <output aria-label={label} className={cn("inline-block leading-none", className)}>
      <span className="waveform-loader" style={{ height: size, gap }} aria-hidden="true">
        {barDescriptors(bars).map((bar) => (
          <span
            key={bar.id}
            className="waveform-loader__bar"
            style={
              {
                width: barWidth,
                "--wf-h": bar.height,
                "--wf-delay": bar.delay,
              } as CSSProperties
            }
          />
        ))}
      </span>
    </output>
  );
}
