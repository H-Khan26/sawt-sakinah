import gold from "@/assets/logo/logo-gold.svg";
import oxblood from "@/assets/logo/logo-oxblood.svg";
import vellum from "@/assets/logo/logo-vellum.svg";
import { cn } from "@/lib/cn";

export type LogoTone = "gold" | "oxblood" | "vellum";

const SOURCES: Record<LogoTone, string> = { gold, oxblood, vellum };

export interface LogoProps {
  /** Gold on oxblood or night, oxblood on paper, vellum on dark photos. */
  tone?: LogoTone;
  /** Size it by height or width; the other side follows the artwork. */
  className?: string;
}

/**
 * The صوت السكينة calligraphy: one Thuluth composition with full tashkeel, so the words never
 * split into lockups. Each tone is its own file, since the logo is never recoloured outside its
 * three colours. Below 32 px rendered height, use the app icon instead.
 */
export function Logo({ tone = "gold", className }: LogoProps) {
  return (
    <img
      src={SOURCES[tone]}
      alt="صوت السكينة — Sawt Sakinah"
      draggable={false}
      className={cn("block select-none", className)}
    />
  );
}

/**
 * "Sawt Sakinah" set as the logo's caption: Ibarra Real Nova, uppercase, tracked 0.4em. The
 * matching left padding balances the trailing tracking so the name centres under the logo.
 */
export function LatinName({ className }: { className?: string }) {
  return (
    <span className={cn("font-display uppercase tracking-[0.4em] pl-[0.4em]", className)}>
      Sawt Sakinah
    </span>
  );
}
