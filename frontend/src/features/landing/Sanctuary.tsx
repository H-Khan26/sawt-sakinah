import { DomeRosette, LampRing, Lattice } from "@/components/ornament";
import { LatinName, Logo } from "@/components/ornament/Logo";
import { lampRingGeometry } from "@/ornament/chandelier";
import type { ReactNode } from "react";
import "./sanctuary.css";
import { useDescent } from "./useDescent";

/** Drawn invisible on mount; the descent places everything before the first paint. */
const HIDDEN_DOME = { transform: { x: 0, y: 0, scale: 0 }, opacity: 0 };
const HIDDEN_LAMPS = lampRingGeometry({ progress: 0, width: 0, height: 0, headerHeight: 0, R0: 0 });
const HIDDEN = { opacity: 0 };

export interface SanctuaryProps {
  /** Buttons in the stage's top-right corner, over the dome and the header. */
  corner: ReactNode;
  /** Content of the qibla wall, below the header. */
  children: ReactNode;
}

/**
 * The library's frame: one scroll container holding a sticky stage and the wall below it. The
 * stage is the dome band (the rosette, the stacked and horizontal logos and, on the landing, the
 * name and an Enter button), the lamp ring over it, and the corner buttons. Scrolling lowers the
 * band from the full window to the header (see {@link useDescent}); the wall then carries the
 * light from the lamps and the star lattice fading in below it. The stage passes pointer events
 * through, so dropping a file or pasting a link on the landing still imports. Until the
 * preferences decide whether the landing shows, the stage is plain dome ground.
 */
export function Sanctuary({ corner, children }: SanctuaryProps) {
  const { opening, descend, refs } = useDescent();

  const enter = () => {
    descend();
    // The Enter button hides as the band lowers; the container keeps keyboard focus.
    refs.scroller.current?.focus({ preventScroll: true });
  };

  return (
    <section
      ref={refs.scroller}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll container takes focus so the keyboard can scroll it and run the descent.
      tabIndex={0}
      aria-label="Library"
      className="sanct"
      data-open={opening ?? undefined}
    >
      <header className="sanct-stage">
        <div className="sanct-band">
          {opening && (
            <>
              <DomeRosette ref={refs.dome} {...HIDDEN_DOME} />
              <div ref={refs.stacked} className="sanct-logo" style={HIDDEN}>
                <Logo lockup="stacked" tone="gold" className="h-auto w-full" />
              </div>
              <div ref={refs.horizontal} className="sanct-logo" style={HIDDEN} aria-hidden="true">
                <Logo lockup="horizontal" tone="gold" className="h-auto w-full" />
              </div>
              <div ref={refs.landing} className="sanct-landing">
                <LatinName className="text-xs" />
                <button type="button" className="sanct-enter" onClick={enter}>
                  Enter ↓
                </button>
              </div>
            </>
          )}
        </div>
        {opening && (
          <>
            <LampRing ref={refs.lamps} geometry={HIDDEN_LAMPS} />
            <div className="sanct-corner">{corner}</div>
          </>
        )}
      </header>
      <div className="sanct-spacer" />
      <div className="sanct-wall">
        <Lattice className="sanct-lattice" />
        {children}
      </div>
    </section>
  );
}
