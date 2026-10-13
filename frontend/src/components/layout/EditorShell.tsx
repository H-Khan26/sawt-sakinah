import { Button, Tooltip } from "@/components/ui";
import { SettingsButton } from "@/features/settings/SettingsButton";
import { ThemeSwitch } from "@/features/settings/ThemeSwitch";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { ICON_BARS, iconArchPath } from "@/ornament/arch";
import { LibraryBig, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

const ARCH = iconArchPath();
const ARCH_LINE = iconArchPath(4.5, 4);

/** Square rail button size: a 44 px target inside the 88 px rail. */
const RAIL_BUTTON = "h-11 w-11 border-transparent hover:border-dome-on/40";

/** The app mark: the mihrab arch and its three bars on a rounded tile, coloured by the mark tokens. */
function RailMark() {
  return (
    <svg viewBox="0 0 100 100" width={48} height={48} aria-hidden="true" focusable="false">
      <rect width="100" height="100" rx="22" fill="var(--mark-tile)" />
      <path d={ARCH} fill="var(--mark-arch)" stroke="var(--mark-arch-edge)" strokeWidth="3" />
      <path d={ARCH_LINE} fill="none" stroke="var(--mark-arch-line)" strokeWidth="1" />
      <g fill="var(--mark-bars)">
        {ICON_BARS.map((b) => (
          <rect key={b.x} x={b.x} y={b.y} width={b.width} height={b.height} rx={b.rx} />
        ))}
      </g>
    </svg>
  );
}

function RailLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Tooltip content={label} side="right">
      <Button
        size="icon"
        variant="dome"
        aria-label={label}
        onClick={() => navigate(to)}
        className={RAIL_BUTTON}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * Editor layout: an 88 px binding rail on the dome ground with a gold inner edge, then the main
 * area. The rail carries the app mark (home), the library, a new recording, and at its foot the
 * theme switch and settings. The {@link UpdateBanner} heads the main column, which scrolls.
 */
export function EditorShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <nav
        aria-label="Editor"
        className="flex w-[88px] shrink-0 flex-col items-center gap-3 border-r border-gold bg-dome py-5"
      >
        <Tooltip content="Home" side="right">
          <Link
            to="/"
            aria-label="Sawt Sakinah home"
            className="block rounded-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dome-on focus-visible:ring-offset-2 focus-visible:ring-offset-dome"
          >
            <RailMark />
          </Link>
        </Tooltip>
        <div aria-hidden="true" className="my-2 h-px w-9 bg-gold" />
        <RailLink to="/" label="Library">
          <LibraryBig size={20} strokeWidth={1.6} />
        </RailLink>
        <RailLink to="/new" label="New recording">
          <Plus size={22} strokeWidth={1.6} />
        </RailLink>
        <div className="mt-auto flex flex-col items-center gap-3">
          <ThemeSwitch tooltipSide="right" className={RAIL_BUTTON} />
          <SettingsButton tooltipSide="right" className={RAIL_BUTTON} />
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <UpdateBanner />
        <main className="relative min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
