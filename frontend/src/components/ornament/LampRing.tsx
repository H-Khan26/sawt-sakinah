import { cn } from "@/lib/cn";
import type { LampRingGeometry } from "@/ornament/chandelier";
import { num } from "@/ornament/num";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { useSvgId } from "./useSvgId";

const LAMP = "var(--lamp-stroke)";

export interface LampRingProps {
  /** The ring at the current point of the descent, from `lampRingGeometry`. */
  geometry: LampRingGeometry;
  className?: string;
}

/** Redraws the ring in place, without a React render (one call per frame). */
export interface LampRingHandle {
  update: (geometry: LampRingGeometry) => void;
}

const clip = (lampClip: number) => `inset(0 0 max(0px, calc(100% - ${num(lampClip, 1)}px)) 0)`;

/**
 * The chandelier's lamp ring over the stage: back and front hoops, 32 lamps (glow, cord, cup)
 * and the pool of light below, clipped so lamps show only above `geometry.lampClip`. The
 * `geometry` prop draws it when it mounts; the ref's `update` redraws it per frame with the same
 * number of lamps.
 */
export const LampRing = forwardRef<LampRingHandle, LampRingProps>(function LampRing(
  { geometry: g, className },
  ref,
) {
  const base = useSvgId("lamps");
  const svg = useRef<SVGSVGElement>(null);
  const pool = useRef<SVGGElement>(null);
  const poolShape = useRef<SVGEllipseElement>(null);
  const back = useRef<SVGGElement>(null);
  const backHoop = useRef<SVGPathElement>(null);
  const frontHoop = useRef<SVGPathElement>(null);
  const lamps = useRef<(SVGGElement | null)[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      update: (next) => {
        svg.current?.style.setProperty("clip-path", clip(next.lampClip));
        pool.current?.setAttribute("opacity", num(next.pool.opacity));
        const e = poolShape.current;
        if (e) {
          e.setAttribute("cx", num(next.pool.cx));
          e.setAttribute("cy", num(next.pool.cy));
          e.setAttribute("rx", num(next.pool.rx));
          e.setAttribute("ry", num(next.pool.ry));
        }
        back.current?.setAttribute("opacity", num(next.backOpacity));
        backHoop.current?.setAttribute("d", next.hoopBack);
        frontHoop.current?.setAttribute("d", next.hoopFront);
        next.lamps.forEach((lamp, i) => {
          const el = lamps.current[i];
          if (!el) return;
          el.setAttribute("transform", `translate(${num(lamp.x)} ${num(lamp.y)})`);
          el.setAttribute("opacity", num(lamp.opacity));
          const [glow, cord, cup] = el.children;
          const drop = num(lamp.drop);
          glow?.setAttribute("cy", drop);
          cord?.setAttribute("y2", drop);
          cup?.setAttribute("cy", drop);
        });
      },
    }),
    [],
  );

  return (
    <svg
      ref={svg}
      aria-hidden="true"
      focusable="false"
      className={cn("dome-art", className)}
      style={{ clipPath: clip(g.lampClip) }}
    >
      <defs>
        <radialGradient id={`${base}-lamp`}>
          <stop offset="0" style={{ stopColor: LAMP, stopOpacity: 0.75 }} />
          <stop offset="0.35" style={{ stopColor: LAMP, stopOpacity: 0.25 }} />
          <stop offset="1" style={{ stopColor: LAMP, stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${base}-pool`}>
          <stop offset="0" style={{ stopColor: LAMP, stopOpacity: 0.16 }} />
          <stop offset="1" style={{ stopColor: LAMP, stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <g ref={pool} opacity={g.pool.opacity}>
        <ellipse
          ref={poolShape}
          className="lamp-glow"
          cx={g.pool.cx}
          cy={g.pool.cy}
          rx={g.pool.rx}
          ry={g.pool.ry}
          fill={`url(#${base}-pool)`}
        />
      </g>
      <g ref={back} opacity={g.backOpacity}>
        <path ref={backHoop} className="d-soft" d={g.hoopBack} />
      </g>
      <path ref={frontHoop} className="d-line" d={g.hoopFront} />
      {g.lamps.map((lamp, i) => (
        <g
          key={lamp.angle}
          ref={(el) => {
            lamps.current[i] = el;
          }}
          transform={`translate(${num(lamp.x)} ${num(lamp.y)})`}
          opacity={lamp.opacity}
        >
          <circle className="lamp-glow" r="9" cy={lamp.drop} fill={`url(#${base}-lamp)`} />
          <line className="d-line" x1="0" y1="0" x2="0" y2={lamp.drop} />
          <circle className="lamp" r="2" cy={lamp.drop} />
        </g>
      ))}
    </svg>
  );
});
