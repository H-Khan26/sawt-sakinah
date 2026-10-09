import { Button, Tooltip } from "@/components/ui";
import { Settings } from "lucide-react";
import { useState } from "react";
import { SettingsModal } from "./SettingsModal";

/** Header gear that opens {@link SettingsModal}. */
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Settings" side="bottom">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen(true)}
          aria-label="Open settings"
          className="h-11 w-11 px-0"
        >
          <Settings size={22} />
        </Button>
      </Tooltip>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
