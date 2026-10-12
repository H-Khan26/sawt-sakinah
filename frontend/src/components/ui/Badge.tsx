import { cn } from "@/lib/cn";
import type { MarkerType } from "@/types/api";
import type { HTMLAttributes } from "react";

export type BadgeVariant = "neutral" | "accent" | "green" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: "bg-background-tertiary text-text-secondary",
  accent: "bg-accent text-accent-on",
  green: "bg-green text-accent-on",
  danger: "bg-danger text-accent-on",
};

/**
 * Maps a detected marker `type` to a badge variant, so marker chips colour consistently: takbir
 * uses the accent, the other known phrase types binding green, and custom markers neutral.
 */
export const markerTypeVariant: Record<string, BadgeVariant> = {
  takbir: "accent",
  tasmi: "green",
  tahmid: "green",
  tasleem: "green",
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
