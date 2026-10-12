import { cn } from "@/lib/cn";

export interface ViewIconProps {
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

/** Icon-view glyph for the library toggle: two pointed arches side by side, stroked in currentColor. */
export function ArchToggleIcon({ size = 14, className }: ViewIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("orn-glyph", className)}
    >
      <path d="M1.5 15V9Q1.5 5.5 4.25 3.5Q7 5.5 7 9V15ZM9 15V9Q9 5.5 11.75 3.5Q14.5 5.5 14.5 9V15Z" />
    </svg>
  );
}

/** List-view glyph for the library toggle: three rules with leading dots, stroked in currentColor. */
export function ListIcon({ size = 14, className }: ViewIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("orn-glyph", className)}
    >
      <path d="M5 4h9M5 8h9M5 12h9M2 4h.5M2 8h.5M2 12h.5" />
    </svg>
  );
}
