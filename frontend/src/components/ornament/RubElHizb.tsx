import { cn } from "@/lib/cn";
import { toArabicIndic } from "@/lib/format";
import { rubElHizbPath } from "@/ornament/star";

const STAR = rubElHizbPath(48);

export interface RubElHizbProps {
  /** Number set in the centre in Arabic-Indic digits (Amiri Bold). */
  numeral?: number;
  /** Fills the star with the accent (the current item). */
  filled?: boolean;
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

/** Rub el Hizb: the 8-point star that numbers list rows and marks rak'ahs, outlined or filled. */
export function RubElHizb({ numeral, filled = false, size = 24, className }: RubElHizbProps) {
  return (
    <svg
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("orn-star", filled && "filled", className)}
    >
      <path className="s-body" d={STAR} />
      {numeral !== undefined && (
        <text className="s-num" x="0" y="13" textAnchor="middle" fontSize="38">
          {toArabicIndic(numeral)}
        </text>
      )}
    </svg>
  );
}
