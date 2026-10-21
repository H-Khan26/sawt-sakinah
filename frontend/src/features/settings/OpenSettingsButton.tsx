import { Button } from "@/components/ui";
import type { ButtonProps } from "@/components/ui";
import { Settings } from "lucide-react";
import { useState } from "react";
import { SettingsModal, type SettingsSection } from "./SettingsModal";

/**
 * Labelled button that opens {@link SettingsModal}, for messages that point to a setting;
 * `section` opens it at that part.
 */
export function OpenSettingsButton({
  children = "Open Settings",
  size = "sm",
  variant = "secondary",
  section,
  ...rest
}: Omit<ButtonProps, "onClick"> & { section?: SettingsSection }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} {...rest}>
        <Settings size={16} />
        {children}
      </Button>
      {open && <SettingsModal section={section} onClose={() => setOpen(false)} />}
    </>
  );
}
