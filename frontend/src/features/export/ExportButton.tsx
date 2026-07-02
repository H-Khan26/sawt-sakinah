/**
 * Entry point for the export flow: a button that opens the `ExportModal`. The modal is
 * mounted only while open so each export starts clean and no job polls in the background
 * after it is dismissed.
 */
import { Button } from "@/components/ui";
import type { ProjectView } from "@/types/api";
import { useState } from "react";
import { ExportModal } from "./ExportModal";

export function ExportButton({ project }: { project: ProjectView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Export</Button>
      {open && <ExportModal project={project} onClose={() => setOpen(false)} />}
    </>
  );
}
