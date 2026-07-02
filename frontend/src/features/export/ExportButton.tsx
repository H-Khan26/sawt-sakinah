/**
 * Entry point for the export flow: a button that opens the `ExportModal`. The modal is
 * mounted only while open so each export starts clean and no job polls in the background
 * after it is dismissed.
 */
import { Button, Tooltip } from "@/components/ui";
import type { ProjectView } from "@/types/api";
import { Download } from "lucide-react";
import { useState } from "react";
import { ExportModal } from "./ExportModal";

export function ExportButton({ project }: { project: ProjectView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Export" side="bottom">
        <Button onClick={() => setOpen(true)} aria-label="Export" className="h-11 w-11 px-0">
          <Download size={24} />
        </Button>
      </Tooltip>
      {open && <ExportModal project={project} onClose={() => setOpen(false)} />}
    </>
  );
}
