import { Button, Tooltip, type TooltipSide } from "@/components/ui";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { SettingsModal } from "./SettingsModal";

/** Button on the dome ground (library header, editor rail) that opens {@link SettingsModal}. */
export function SettingsButton({
  tooltipSide = "bottom",
  className,
}: {
  tooltipSide?: TooltipSide;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Settings" side={tooltipSide}>
        <Button
          size="icon"
          variant="dome"
          onClick={() => setOpen(true)}
          aria-label="Open settings"
          className={className}
        >
          <SlidersHorizontal size={18} strokeWidth={1.6} />
        </Button>
      </Tooltip>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
