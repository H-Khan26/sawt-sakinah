import { cn } from "@/lib/cn";
import { type DomeGradient, type DomePrimitive, domeRosette } from "@/ornament/dome";
import { num } from "@/ornament/num";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { useSvgId } from "./useSvgId";

const ROSETTE = domeRosette();

const TONE = { window: "var(--dome-window)", line: "var(--dome-line)" } as const;

/** Where the rosette sits and how far each of its layers has faded. */
export interface DomeRosetteState {
  /** Places the rosette: centre in px and radius R in px. */
  transform: { x: number; y: number; scale: number };
  /** Opacity of the whole rosette. */
  opacity?: number;
  /** Opacity of the windows and ribs. */
  windowOpacity?: number;
  /** Opacity of the 16-fold cartouche band. */
  bandOpacity?: number;
}

export interface DomeRosetteProps extends DomeRosetteState {
  className?: string;
}

/** Moves and fades the drawn rosette in place, without a React render (one call per frame). */
export interface DomeRosetteHandle {
  update: (state: DomeRosetteState) => void;
}

const placement = ({ x, y, scale }: DomeRosetteState["transform"]) =>
  `translate(${num(x)} ${num(y)}) scale(${num(scale)})`;

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
 * independently. The props place it when it mounts; the ref's `update` moves it per frame.
 */
export const DomeRosette = forwardRef<DomeRosetteHandle, DomeRosetteProps>(function DomeRosette(
  { transform, opacity = 1, windowOpacity = 1, bandOpacity = 1, className },
  ref,
) {
  const base = useSvgId("dome");
  const gradientId = (name: string) => `${base}-${name}`;
  const whole = useRef<SVGGElement>(null);
  const windows = useRef<SVGGElement>(null);
  const band = useRef<SVGGElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      update: (state) => {
        whole.current?.setAttribute("transform", placement(state.transform));
        whole.current?.setAttribute("opacity", num(state.opacity ?? 1));
        windows.current?.setAttribute("opacity", num(state.windowOpacity ?? 1));
        band.current?.setAttribute("opacity", num(state.bandOpacity ?? 1));
      },
    }),
    [],
  );

  return (
    <svg aria-hidden="true" focusable="false" className={cn("dome-art", className)}>
      <defs>
        {ROSETTE.gradients.map((g) => (
          <Gradient key={g.name} gradient={g} id={gradientId(g.name)} />
        ))}
      </defs>
      <g ref={whole} transform={placement(transform)} opacity={opacity}>
        <Primitives items={ROSETTE.light} gradientId={gradientId} />
        <Primitives items={ROSETTE.rims} gradientId={gradientId} />
        <g ref={windows} opacity={windowOpacity}>
          <Primitives items={ROSETTE.windows} gradientId={gradientId} />
        </g>
        <Primitives items={ROSETTE.rings} gradientId={gradientId} />
        <g ref={band} opacity={bandOpacity}>
          <Primitives items={ROSETTE.band} gradientId={gradientId} />
        </g>
        <Primitives items={ROSETTE.medallion} gradientId={gradientId} />
      </g>
    </svg>
  );
});
