import { cn } from "@/lib/cn";
import type { MarkerType } from "@/types/api";
import type { HTMLAttributes } from "react";

export type BadgeVariant = "neutral" | "accent" | "accent-secondary" | "info" | "success";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: "bg-background-tertiary text-text-secondary",
  accent: "bg-accent text-white",
  "accent-secondary": "bg-accent-secondary text-white",
  info: "bg-info text-white",
  success: "bg-success text-white",
};

/**
 * Maps a detected marker `type` to a badge variant. Exported so the marker layer
 * (Phase 6) can color chips consistently: takbir uses the primary accent, the other
 * known phrase types use the secondary accent, unknown/custom fall back to neutral.
 */
export const markerTypeVariant: Record<string, BadgeVariant> = {
  takbir: "accent",
  tasmi: "accent-secondary",
  tahmid: "accent-secondary",
  tasleem: "accent-secondary",
  custom: "neutral",
};

export function badgeVariantForMarker(type: MarkerType): BadgeVariant {
  return markerTypeVariant[type] ?? "neutral";
}

export function Badge({ variant = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
