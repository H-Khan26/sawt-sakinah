import horizontalGold from "@/assets/logo/logo-horizontal-gold.svg";
import horizontalOxblood from "@/assets/logo/logo-horizontal-oxblood.svg";
import horizontalVellum from "@/assets/logo/logo-horizontal-vellum.svg";
import stackedGold from "@/assets/logo/logo-stacked-gold.svg";
import stackedOxblood from "@/assets/logo/logo-stacked-oxblood.svg";
import stackedVellum from "@/assets/logo/logo-stacked-vellum.svg";
import { cn } from "@/lib/cn";

export type LogoLockup = "horizontal" | "stacked";
export type LogoTone = "gold" | "oxblood" | "vellum";

const SOURCES: Record<LogoLockup, Record<LogoTone, string>> = {
  horizontal: { gold: horizontalGold, oxblood: horizontalOxblood, vellum: horizontalVellum },
  stacked: { gold: stackedGold, oxblood: stackedOxblood, vellum: stackedVellum },
};

export interface LogoProps {
  /** One line for headers, or stacked for the landing and about screens. */
  lockup?: LogoLockup;
  /** Gold on oxblood or night, oxblood on paper, vellum on dark photos. */
  tone?: LogoTone;
  /** Size it by height or width; the other side follows the artwork. */
  className?: string;
}

/**
 * The صوت السكينة calligraphy. Each lockup and tone is its own file, since the logo is never
 * recoloured outside its three colours. Below 18 px rendered height, use the app icon instead.
 */
export function Logo({ lockup = "horizontal", tone = "gold", className }: LogoProps) {
  return (
    <img
      src={SOURCES[lockup][tone]}
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
