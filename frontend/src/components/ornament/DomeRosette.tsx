import { cn } from "@/lib/cn";
import { type DomeGradient, type DomePrimitive, domeRosette } from "@/ornament/dome";
import { useSvgId } from "./useSvgId";

const ROSETTE = domeRosette();

const TONE = { window: "var(--dome-window)", line: "var(--dome-line)" } as const;

export interface DomeRosetteProps {
  /** Places the rosette: centre in px and radius R in px. */
  transform: { x: number; y: number; scale: number };
  /** Opacity of the whole rosette. */
  opacity?: number;
  /** Opacity of the windows and ribs. */
  windowOpacity?: number;
  /** Opacity of the 16-fold cartouche band. */
  bandOpacity?: number;
  className?: string;
}

function Primitives({
  items,
  gradientId,
}: { items: DomePrimitive[]; gradientId: (name: string) => string }) {
  return (
    <>
      {items.map((p) =>
        p.kind === "circle" ? (
          <circle
            key={`${p.cls}-${p.r}`}
            className={p.cls}
            r={p.r}
            fill={p.gradient ? `url(#${gradientId(p.gradient)})` : undefined}
          />
        ) : (
          <path
            key={`${p.cls}-${p.transform ?? p.d}`}
            className={p.cls}
            d={p.d}
            transform={p.transform}
          />
        ),
      )}
    </>
  );
}

function Gradient({ gradient, id }: { gradient: DomeGradient; id: string }) {
  return (
    <radialGradient id={id} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1">
      {gradient.stops.map((s) => (
        <stop
          key={s.offset}
          offset={s.offset}
          style={{ stopColor: TONE[gradient.tone], stopOpacity: s.opacity }}
        />
      ))}
    </radialGradient>
  );
}

/**
 * The dome rosette seen from below, drawn in units of R and placed by `transform`. Fills its
 * positioned container; strokes stay 1 px at any scale. Windows, band and the whole fade
 * independently.
 */
export function DomeRosette({
  transform,
  opacity = 1,
  windowOpacity = 1,
  bandOpacity = 1,
  className,
}: DomeRosetteProps) {
  const base = useSvgId("dome");
  const gradientId = (name: string) => `${base}-${name}`;
  const { x, y, scale } = transform;
  return (
    <svg aria-hidden="true" focusable="false" className={cn("dome-art", className)}>
      <defs>
        {ROSETTE.gradients.map((g) => (
          <Gradient key={g.name} gradient={g} id={gradientId(g.name)} />
        ))}
      </defs>
      <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity}>
        <Primitives items={ROSETTE.light} gradientId={gradientId} />
        <Primitives items={ROSETTE.rims} gradientId={gradientId} />
        <g opacity={windowOpacity}>
          <Primitives items={ROSETTE.windows} gradientId={gradientId} />
        </g>
        <Primitives items={ROSETTE.rings} gradientId={gradientId} />
        <g opacity={bandOpacity}>
          <Primitives items={ROSETTE.band} gradientId={gradientId} />
        </g>
        <Primitives items={ROSETTE.medallion} gradientId={gradientId} />
      </g>
    </svg>
  );
}
