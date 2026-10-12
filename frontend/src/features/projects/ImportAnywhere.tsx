import { useCreateProject, useUploadProject } from "@/api/hooks";
import { CetvelFrame } from "@/components/ornament";
import { Progress, useToast } from "@/components/ui";
import { isLikelyYouTubeUrl } from "@/lib/youtube";
import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useOpenImport } from "./useOpenImport";

/** True when typing or pasting goes into a field rather than the page. */
function isEditable(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/**
 * Imports from anywhere on the library: dropping a file on the window uploads it, and pasting a
 * YouTube link while no field has focus starts its extraction; either opens the editor on the new
 * job. Shows a "Drop to import" overlay while a file is dragged over the window, and an importing
 * overlay until the editor opens. A drop that something else already handled (`preventDefault`,
 * e.g. the New recording sheet's drop zone) is left alone, and nothing new starts while another
 * import or change is in flight. `paused` (a dialog is open) turns it all off.
 */
export function ImportAnywhere({ paused = false }: { paused?: boolean }) {
  const upload = useUploadProject();
  const create = useCreateProject();
  const openImport = useOpenImport();
  const { toast } = useToast();
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const busy = upload.isPending || create.isPending;
  // Counts every mutation in flight, including an import the sheet started.
  const mutating = useIsMutating();
  const blocked = paused || mutating > 0;

  const importFile = (file: File) => {
    if (blocked) return;
    setProgress(0);
    upload.mutate(
      { file, onProgress: setProgress },
      {
        onSuccess: ({ project_id, job_id }) => openImport(project_id, job_id),
        onError: (err) => toast(`Couldn't import that file: ${err.message}`, "error"),
      },
    );
  };

  const importUrl = (url: string) => {
    if (blocked) return;
    create.mutate(
      { url },
      {
        onSuccess: ({ project_id, job_id }) => openImport(project_id, job_id, url),
        onError: (err) => toast(`Couldn't import that link: ${err.message}`, "error"),
      },
    );
  };

  // The window listeners bind once and call the latest handlers through this ref.
  const handlers = useRef({ importFile, importUrl, paused });
  handlers.current = { importFile, importUrl, paused };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      if (!handlers.current.paused) setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = 0;
      setDragging(false);
      if (e.defaultPrevented) return;
      // Keeps the browser from opening the file in place of the app.
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) handlers.current.importFile(file);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (handlers.current.paused || isEditable(document.activeElement)) return;
      const text = e.clipboardData?.getData("text/plain").trim() ?? "";
      if (!isLikelyYouTubeUrl(text)) return;
      e.preventDefault();
      handlers.current.importUrl(text);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  if (!busy && !(dragging && !paused)) return null;

  return (
    // While importing it sits above any open sheet (z-50) and blocks it; while dragging it sits
    // below, so the sheet's own drop zone stays visible.
    <div
      className={
        busy
          ? "fixed inset-0 z-[60] grid place-items-center bg-scrim p-6"
          : "pointer-events-none fixed inset-0 z-40 grid place-items-center bg-scrim p-6"
      }
    >
      <CetvelFrame
        className="w-full max-w-md bg-surface shadow-xl !border-dashed"
        innerClassName="flex flex-col items-center gap-3 px-8 py-12 text-center !border-dashed"
      >
        {busy ? (
          <>
            <output className="font-display text-[30px] leading-tight text-text">Importing…</output>
            <Progress
              value={upload.isPending ? progress : null}
              label="Importing"
              className="max-w-xs"
            />
          </>
        ) : (
          <>
            <p className="font-display text-[30px] leading-tight text-text">Drop to import</p>
            <p className="font-sans text-sm text-text-secondary">An audio or video file</p>
          </>
        )}
      </CetvelFrame>
    </div>
  );
}
