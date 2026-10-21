import { ApiError } from "@/api/client";
import { useCreateProject, usePlatforms, useUploadProject } from "@/api/hooks";
import { Alert, Button, Input, Modal, Progress } from "@/components/ui";
import { cn } from "@/lib/cn";
import { type LinkCheck, checkLink, listLabels } from "@/lib/links";
import { UploadCloud, X } from "lucide-react";
import type { DragEvent, FormEvent } from "react";
import { useRef, useState } from "react";
import { ImportErrorActions } from "./ImportErrorActions";
import { useOpenImport } from "./useOpenImport";

/**
 * The "New recording" sheet over the library: a link field (focused, Enter starts the import)
 * and, under it, a drop zone that uploads a local file. Both POST to the backend (the real
 * validator) and open the editor on the returned job. Closing calls `onClose`.
 */
export function NewRecordingSheet({ onClose }: { onClose: () => void }) {
  const openImport = useOpenImport();
  const platforms = usePlatforms();
  const labels = platforms.data?.map((p) => p.label);
  const sites = labels ? `a link from ${listLabels(labels, "or")}` : "a link";

  return (
    <Modal open onClose={onClose} ariaLabel="New recording" className="max-w-lg">
      <div className="relative flex flex-col gap-5 p-6">
        <div className="pr-10">
          <h2 className="font-display text-[26px] leading-tight text-text">New recording</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Paste {sites}, or add an audio or video file.
          </p>
        </div>

        <LinkForm onReady={openImport} />

        <div
          aria-hidden="true"
          className="flex items-center gap-3 font-sans text-xs uppercase tracking-[0.16em] text-text-tertiary"
        >
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <UploadForm onReady={openImport} />

        {/* After the fields in the DOM, so the modal focuses the link field first. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-4 top-4 text-text-secondary"
        >
          <X size={18} />
        </Button>
      </div>
    </Modal>
  );
}

interface ReadyHandler {
  onReady: (projectId: string, jobId: string, url?: string) => void;
}

/** The field's hint for a link that passed the check: the site and what it links to. */
function linkHint(check: Extract<LinkCheck, { ok: true }>): string {
  const p = check.platform;
  if (!p) return "Press Enter to import.";
  const base = `${p.label} ${check.share ? "link" : p.item} · press Enter`;
  return p.limited && p.reason ? `${base}. ${p.reason}` : base;
}

/** Paste a link to a post or video and press Enter. */
function LinkForm({ onReady }: ReadyHandler) {
  const create = useCreateProject();
  const platforms = usePlatforms();
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);

  const text = url.trim();
  const check = text ? checkLink(text, platforms.data) : null;
  // The backend refuses a link it can't use (400: not a single post, say; or a site this
  // install can't import from) with a message for the field; other failures get the alert.
  const refused =
    create.error instanceof ApiError &&
    (create.error.status === 400 || create.error.type === "PlatformUnavailableError");
  const fieldError = check && !check.ok ? check.message : refused ? create.error?.message : null;
  const fieldAction =
    check && !check.ok ? check.action : refused ? (create.error as ApiError).action : null;
  const invalid = Boolean(fieldError) && (touched || refused);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (create.isPending || !check?.ok) return;
    create.mutate(
      { url: text },
      { onSuccess: ({ project_id, job_id }) => onReady(project_id, job_id, text) },
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Input
        label="Link"
        placeholder="https://…"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          if (create.isError) create.reset();
        }}
        onBlur={() => setTouched(true)}
        invalid={invalid}
        hint={invalid ? fieldError : check?.ok ? linkHint(check) : "Press Enter to import."}
        readOnly={create.isPending}
        autoFocus
        inputMode="url"
        enterKeyHint="go"
      />
      {invalid && <ImportErrorActions action={fieldAction} message={fieldError} />}
      {create.isPending && <Progress label="Starting the import" />}
      {create.isError && !refused && (
        <Alert variant="error" title="Couldn't start the import">
          {create.error.message}
        </Alert>
      )}
    </form>
  );
}

// Kept in sync with `extraction.allowed_upload_extensions` in the backend config. The
// backend re-validates, so this only shapes the native picker and the hint text.
const ACCEPTED_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".opus",
  ".ogg",
  ".mov",
  ".mp4",
  ".m4v",
];
const ACCEPT_ATTR = [...ACCEPTED_EXTENSIONS, "audio/*", "video/*"].join(",");

/**
 * Drop a file or choose one; the upload starts as soon as a file is picked. A drop here is
 * marked handled (`preventDefault`) so the library's drop-anywhere handler skips it.
 */
function UploadForm({ onReady }: ReadyHandler) {
  const uploadProject = useUploadProject();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const busy = uploadProject.isPending;

  const start = (file: File) => {
    if (busy) return;
    setProgress(0);
    uploadProject.mutate(
      { file, onProgress: setProgress },
      { onSuccess: ({ project_id, job_id }) => onReady(project_id, job_id) },
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) start(file);
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 rounded border-2 border-dashed px-6 py-7 text-center transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-60",
          dragging ? "border-accent bg-accent-soft" : "border-border hover:border-border-focus",
        )}
      >
        <UploadCloud size={24} className="text-text-tertiary" />
        <span className="text-sm text-text">
          {busy ? "Uploading…" : "Drop a file here, or choose a file"}
        </span>
        <span className="text-xs text-text-tertiary">
          MP3, WAV, M4A, FLAC, iPhone video (MOV/MP4), voice notes (OPUS/OGG), and more
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) start(file);
          e.target.value = ""; // allow re-selecting the same file after an error
        }}
      />

      {busy && <Progress value={progress} label="Uploading file" />}

      {uploadProject.isError && (
        <Alert variant="error" title="Couldn't upload that file">
          {uploadProject.error.message}
        </Alert>
      )}
    </div>
  );
}
