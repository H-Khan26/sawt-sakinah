import { cn } from "@/lib/cn";
import type { LampRingGeometry } from "@/ornament/chandelier";
import { useSvgId } from "./useSvgId";

const LAMP = "var(--lamp-stroke)";

export interface LampRingProps {
  /** The ring at the current point of the descent, from `lampRingGeometry`. */
  geometry: LampRingGeometry;
  className?: string;
}

/**
 * The chandelier's lamp ring over the stage: back and front hoops, 32 lamps (glow, cord, cup)
 * and the pool of light below, clipped so lamps show only above `geometry.lampClip`.
 */
export function LampRing({ geometry: g, className }: LampRingProps) {
  const base = useSvgId("lamps");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={cn("dome-art", className)}
      style={{ clipPath: `inset(0 0 max(0px, calc(100% - ${g.lampClip}px)) 0)` }}
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
      <g opacity={g.pool.opacity}>
        <ellipse
          className="lamp-glow"
          cx={g.pool.cx}
          cy={g.pool.cy}
          rx={g.pool.rx}
          ry={g.pool.ry}
          fill={`url(#${base}-pool)`}
        />
      </g>
      <path className="d-soft" d={g.hoopBack} opacity={g.backOpacity} />
      <path className="d-line" d={g.hoopFront} />
      {g.lamps.map((lamp) => (
        <g key={lamp.angle} transform={`translate(${lamp.x} ${lamp.y})`} opacity={lamp.opacity}>
          <circle className="lamp-glow" r="9" cy={lamp.drop} fill={`url(#${base}-lamp)`} />
          <line className="d-line" x1="0" y1="0" x2="0" y2={lamp.drop} />
          <circle className="lamp" r="2" cy={lamp.drop} />
        </g>
      ))}
    </svg>
  );
}
