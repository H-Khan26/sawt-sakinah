import { Button } from "@/components/ui";
import type { ButtonProps } from "@/components/ui";
import { Settings } from "lucide-react";
import { useState } from "react";
import { SettingsModal } from "./SettingsModal";

/** Labelled button that opens {@link SettingsModal}, for messages that point to a setting. */
export function OpenSettingsButton({
  children = "Open Settings",
  size = "sm",
  variant = "secondary",
  ...rest
}: Omit<ButtonProps, "onClick">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} {...rest}>
        <Settings size={16} />
        {children}
      </Button>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  );
}
