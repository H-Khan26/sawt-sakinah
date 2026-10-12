import { Button, Tooltip } from "@/components/ui";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { SettingsModal } from "./SettingsModal";

/** Header button on the dome ground that opens {@link SettingsModal}. */
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Settings" side="bottom">
        <Button size="icon" variant="dome" onClick={() => setOpen(true)} aria-label="Open settings">
          <SlidersHorizontal size={18} strokeWidth={1.6} />
        </Button>
      </Tooltip>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
