import { useCreateProject, useUploadProject } from "@/api/hooks";
import { Alert, Button, Card, Input, Progress, Tabs } from "@/components/ui";
import { isLikelyYouTubeUrl } from "@/lib/youtube";
import { ArrowLeft, UploadCloud } from "lucide-react";
import type { DragEvent, FormEvent } from "react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EditorLocationState } from "./EditorPage";

/**
 * New-project flow: either paste a YouTube link or upload a local media file, then navigate
 * to the editor carrying the resulting job id. Both paths POST to the backend (the real
 * validator) and hand off to the same `useJob` poll in the editor. Reached from the library.
 */
export function NewProjectPage() {
  const navigate = useNavigate();

  const goToEditor = (project_id: string, job_id: string, url?: string) => {
    const state: EditorLocationState = { jobId: job_id, url };
    navigate(`/p/${project_id}`, { state });
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <div className="flex flex-col gap-5">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 self-start text-sm text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus rounded"
          >
            <ArrowLeft size={16} />
            Back to library
          </button>

          <div className="text-center">
            <h1 className="font-serif text-3xl text-accent">New project</h1>
            <p className="mt-1 text-text-secondary">
              Paste a YouTube link or upload a recording to clean up a Quran recitation.
            </p>
          </div>

          <Tabs
            items={[
              { id: "link", label: "Paste link", content: <LinkForm onReady={goToEditor} /> },
              { id: "upload", label: "Upload file", content: <UploadForm onReady={goToEditor} /> },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}

interface ReadyHandler {
  onReady: (projectId: string, jobId: string, url?: string) => void;
}

/** The original paste-a-link path. */
function LinkForm({ onReady }: ReadyHandler) {
  const create = useCreateProject();
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);

  const invalid = touched && url.trim().length > 0 && !isLikelyYouTubeUrl(url);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!isLikelyYouTubeUrl(url)) return;
    create.mutate(
      { url: url.trim() },
      { onSuccess: ({ project_id, job_id }) => onReady(project_id, job_id, url.trim()) },
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Input
        label="YouTube link"
        placeholder="https://www.youtube.com/watch?v=…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => setTouched(true)}
        invalid={invalid}
        hint={invalid ? "That doesn't look like a YouTube link." : undefined}
        autoFocus
        inputMode="url"
      />
      <Button type="submit" loading={create.isPending} disabled={url.trim().length === 0}>
        Start
      </Button>
      {create.isError && (
        <Alert variant="error" title="Couldn't start extraction">
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

/** Drag-and-drop / click-to-browse upload path. Starts the upload as soon as a file is chosen. */
function UploadForm({ onReady }: ReadyHandler) {
  const uploadProject = useUploadProject();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);

  const start = (file: File) => {
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

  const busy = uploadProject.isPending;

  return (
    <div className="flex flex-col gap-4">
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
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-60 ${
          dragging ? "border-accent bg-accent-soft" : "border-border hover:border-border-focus"
        }`}
      >
        <UploadCloud size={28} className="text-text-tertiary" />
        <span className="text-sm text-text">
          {busy ? "Uploading…" : "Drag a file here, or click to browse"}
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
