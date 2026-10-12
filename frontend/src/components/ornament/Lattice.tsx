import { cn } from "@/lib/cn";
import { LATTICE_TILE, latticeDot, latticePath } from "@/ornament/lattice";
import type { CSSProperties } from "react";
import { useSvgId } from "./useSvgId";

const TILE = latticePath();

export interface LatticeProps {
  /** Fades the lattice in from transparent at `maskFrom` px to full at `maskTo` px from the top. */
  maskFrom?: number;
  maskTo?: number;
  /** Shifts the tile grid, in px. */
  offsetX?: number;
  offsetY?: number;
  className?: string;
}

/**
 * The 8-fold star lattice as a full-bleed background: fills its positioned parent at
 * `--lattice-opacity`, optionally masked so it starts below the header.
 */
export function Lattice({ maskFrom, maskTo, offsetX = 0, offsetY = 0, className }: LatticeProps) {
  const id = useSvgId("lattice");
  let style: CSSProperties | undefined;
  if (maskFrom !== undefined && maskTo !== undefined) {
    const mask = `linear-gradient(transparent ${maskFrom}px, black ${maskTo}px)`;
    style = { maskImage: mask, WebkitMaskImage: mask };
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={cn("orn-lattice", className)}
      style={style}
    >
      <defs>
        <pattern
          id={id}
          width={LATTICE_TILE}
          height={LATTICE_TILE}
          patternUnits="userSpaceOnUse"
          x={offsetX}
          y={offsetY}
        >
          <path className="l-line" d={TILE} />
          <circle className="l-dot" cx={latticeDot.cx} cy={latticeDot.cy} r={latticeDot.r} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
