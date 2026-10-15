/**
 * Export dialog: pick format / whether to add surahs as chapters, render the EDL, and deliver
 * the result. Export is the one destructive/rendered step — cuts are applied and (when adding
 * chapters) the project's accepted surah passages are written as named chapters, all
 * server-side.
 *
 * Flow: `useExport` -> poll the job with `useJob` -> on success read the job result. In the
 * desktop app (`AppInfo.export_to_folder`) the backend has already saved the file to the export
 * folder, so the dialog offers "Show in folder" (or, when that save failed, says why and keeps
 * the render in the project to retry); in a browser it offers the download URL. The
 * parent mounts this only while open, so each open starts from a clean state and no job keeps
 * polling after close.
 */
import { exportDownloadUrl } from "@/api/endpoints";
import {
  useAppInfo,
  useExport,
  useJob,
  usePreferences,
  useRevealExport,
  useSaveExport,
} from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Alert, Button, Input, Modal, ModalTitle } from "@/components/ui";
import { formatClock } from "@/lib/time";
import type { ExportArtifactView, ProjectView } from "@/types/api";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

/** A source-time range to scope the export to (from a waveform selection). */
export interface ExportRange {
  start: number;
  end: number;
}

/** Output containers offered in v1. mp3 / m4a carry chapters; wav is raw (no chapters). */
const FORMATS = ["mp3", "m4a", "wav"] as const;

const SELECT_CLASS =
  "h-10 rounded border border-border bg-background px-3 text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50";

const DOWNLOAD_LINK_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded bg-accent px-4 text-base font-medium text-accent-on transition-colors duration-fast hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Split a saved path into its folder and file name (either separator). */
function splitPath(path: string): { folder: string; file: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { folder: path.slice(0, cut), file: path.slice(cut + 1) };
}

export function ExportModal({
  project,
  range,
  onClose,
}: {
  project: ProjectView;
  /** When set, export only this source-time range (edits inside it still applied). */
  range?: ExportRange;
  onClose: () => void;
}) {
  const rangeLabel = range ? `${formatClock(range.start)}–${formatClock(range.end)}` : null;
  const [format, setFormat] = useState<string>("mp3");
  const hasSurahs = project.surahs?.passages.some((p) => p.level === "accept") ?? false;
  const [embedChapters, setEmbedChapters] = useState(hasSurahs);
  const [name, setName] = useState(range ? `${project.name} (${rangeLabel})` : project.name);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const info = useAppInfo();
  const prefs = usePreferences();
  const toFolder = info.data?.export_to_folder ?? false;
  const folder = prefs.data?.export_dir ?? info.data?.default_export_dir ?? null;

  const exportAudio = useExport(project.id);
  const reveal = useRevealExport(project.id);
  const saveExport = useSaveExport(project.id);
  const job = useJob(jobId, { invalidateProject: true });
  const state = job.data?.state;
  const running = exportAudio.isPending || state === "pending" || state === "running";

  // Capture the artifact id (and, in the desktop app, where it was saved) once it succeeds.
  useEffect(() => {
    if (state === "succeeded") {
      const result = job.data?.result;
      if (typeof result?.artifact_id === "string") setArtifactId(result.artifact_id);
      if (typeof result?.saved_path === "string") setSavedPath(result.saved_path);
      if (typeof result?.save_error === "string") setSaveError(result.save_error);
    }
  }, [state, job.data?.result]);

  const trimmedName = name.trim();
  const runExport = () => {
    setArtifactId(null);
    setSavedPath(null);
    setSaveError(null);
    reveal.reset();
    exportAudio.mutate(
      {
        format,
        bitrate: null,
        embed_chapters: embedChapters,
        name: trimmedName || null,
        range_start: range?.start ?? null,
        range_end: range?.end ?? null,
      },
      { onSuccess: (r) => setJobId(r.job_id) },
    );
  };

  const done = artifactId !== null && !running;
  const downloadUrl = done && !toFolder ? exportDownloadUrl(project.id, artifactId) : null;
  const retrySave = (id: string) =>
    saveExport.mutate(id, {
      onSuccess: (r) => {
        setSavedPath(r.saved_path);
        setSaveError(null);
      },
    });
  // Fallback filename only; the backend's Content-Disposition wins on download.
  const downloadName = `${trimmedName || project.name}.${format}`;
  const saved = savedPath ? splitPath(savedPath) : null;
  const noSurahs = embedChapters && !hasSurahs;
  const priorExports = project.exports;

  return (
    <Modal open onClose={onClose} ariaLabel="Export audio">
      <ModalTitle>{range ? "Export selection" : "Export audio"}</ModalTitle>

      <div className="flex flex-col gap-4 px-5 py-4">
        {range && rangeLabel && (
          <div className="rounded border border-border bg-background-secondary/40 px-3 py-2 text-sm text-text-secondary">
            Exporting selection <span className="tabular-nums text-text">{rangeLabel}</span>{" "}
            <span className="text-text-tertiary">
              ({(range.end - range.start).toFixed(1)}s, edits inside applied)
            </span>
          </div>
        )}

        <Input
          label="Name"
          placeholder={project.name}
          value={name}
          disabled={running}
          onChange={(e) => setName(e.target.value)}
          hint={
            toFolder && folder
              ? `Used for the file name. Saved to ${folder}; change the folder in Settings.`
              : "Used for the download filename."
          }
        />

        <label className="flex flex-col gap-1.5 text-sm font-medium text-text-secondary">
          Format
          <select
            className={SELECT_CLASS}
            value={format}
            disabled={running}
            onChange={(e) => setFormat(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            className="accent-accent h-4 w-4 cursor-pointer"
            checked={embedChapters}
            disabled={running}
            onChange={(e) => setEmbedChapters(e.target.checked)}
          />
          Add surahs as chapters
        </label>

        {noSurahs && (
          <p className="text-xs text-text-tertiary">
            No surahs found yet — run Find surahs first, or export without chapters.
          </p>
        )}

        {running && <JobProgress job={job.data} title="Rendering…" />}

        {state === "failed" && (
          <Alert variant="error" title="Export failed">
            {job.data?.error ?? "Something went wrong while rendering."}
          </Alert>
        )}
        {exportAudio.isError && (
          <Alert variant="error" title="Couldn't start the export">
            {exportAudio.error.message}
          </Alert>
        )}

        {saved && !running && (
          <Alert variant="success" title="Export saved">
            Saved to <span className="break-all">{saved.folder}</span> as{" "}
            <span className="break-all font-medium">{saved.file}</span>.
          </Alert>
        )}

        {done && saveError && !savedPath && (
          <Alert
            variant="warning"
            title="Rendered, but not saved to your folder"
            action={{
              label: "Try again",
              onClick: () => artifactId && retrySave(artifactId),
              loading: saveExport.isPending,
            }}
          >
            {saveError} The file is kept in the app until then.
          </Alert>
        )}

        {downloadUrl && (
          <Alert variant="success" title="Export ready">
            Your file is rendered. Download it below.
          </Alert>
        )}

        {priorExports.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <span className="text-sm font-medium text-text-secondary">Previous exports</span>
            <ul className="flex flex-col gap-1">
              {priorExports.map((ex) => (
                <PriorExport
                  key={ex.id}
                  projectId={project.id}
                  projectName={project.name}
                  artifact={ex}
                  toFolder={toFolder}
                  onReveal={() => reveal.mutate(ex.id)}
                  onSave={() => saveExport.mutate(ex.id)}
                  saving={saveExport.isPending && saveExport.variables === ex.id}
                  saveBusy={saveExport.isPending}
                />
              ))}
            </ul>
            {reveal.isError && <p className="text-sm text-danger">{reveal.error.message}</p>}
            {saveExport.isError && (
              <p className="text-sm text-danger">Couldn't save it: {saveExport.error.message}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {done && saved && artifactId ? (
          <Button onClick={() => reveal.mutate(artifactId)} loading={reveal.isPending}>
            <FolderOpen size={16} />
            Show in folder
          </Button>
        ) : downloadUrl ? (
          <a href={downloadUrl} download={downloadName} className={DOWNLOAD_LINK_CLASS}>
            Download
          </a>
        ) : (
          <Button onClick={runExport} loading={running}>
            Export
          </Button>
        )}
      </div>
    </Modal>
  );
}

/** One earlier export: shown in its folder, saved to the folder, or downloaded. */
function PriorExport({
  projectId,
  projectName,
  artifact,
  toFolder,
  onReveal,
  onSave,
  saving,
  saveBusy,
}: {
  projectId: string;
  projectName: string;
  artifact: ExportArtifactView;
  toFolder: boolean;
  onReveal: () => void;
  onSave: () => void;
  saving: boolean;
  /** Any save is running; only one runs at a time. */
  saveBusy: boolean;
}) {
  const label = artifact.name ?? projectName;
  const format = (
    <span className="shrink-0 text-xs uppercase text-text-tertiary">{artifact.format}</span>
  );

  if (!artifact.saved_path && !toFolder) {
    return (
      <li>
        <a
          href={exportDownloadUrl(projectId, artifact.id)}
          className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm text-text hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <span className="truncate">{label}</span>
          {format}
        </a>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 rounded px-2 py-1 text-sm text-text">
      <span className="min-w-0 flex-1 truncate" title={artifact.saved_path ?? undefined}>
        {label}
      </span>
      {format}
      {artifact.saved_path ? (
        <Button size="sm" variant="ghost" onClick={onReveal}>
          <FolderOpen size={14} />
          Show in folder
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={onSave} loading={saving} disabled={saveBusy}>
          Save to folder
        </Button>
      )}
    </li>
  );
}
