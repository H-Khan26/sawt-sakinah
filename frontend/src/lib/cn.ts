/**
 * Tiny class-name merge helper (no dependency). Joins truthy parts with a space so
 * components can compose conditional Tailwind classes inline:
 *   cn("btn", isActive && "btn-active", disabled ? "opacity-50" : null)
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
