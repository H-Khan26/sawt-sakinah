/**
 * Export dialog: pick format / bitrate / whether to embed markers, render the EDL, and
 * download the result. Export is the one destructive/rendered step — cuts are applied and
 * (when embedding) the project's markers are written as labeled chapters, all server-side.
 *
 * Flow: `useExport` -> poll the job with `useJob` -> on success read the artifact id from
 * the job result and offer its download URL. The parent mounts this only while open, so each
 * open starts from a clean state and no job keeps polling after close.
 */
import { exportDownloadUrl } from "@/api/endpoints";
import { useExport, useJob } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Alert, Button, Input, Modal } from "@/components/ui";
import type { ProjectView } from "@/types/api";
import { useEffect, useState } from "react";

/** Output containers offered in v1. mp3 / m4a carry chapters; wav is raw (no chapters). */
const FORMATS = ["mp3", "m4a", "wav"] as const;

const SELECT_CLASS =
  "h-10 rounded border border-border bg-background px-3 text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50";

const DOWNLOAD_LINK_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded bg-accent px-4 text-base font-medium text-white transition-colors duration-fast hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function ExportModal({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const [format, setFormat] = useState<string>("mp3");
  const [bitrate, setBitrate] = useState("");
  const [embedMarkers, setEmbedMarkers] = useState(true);
  const [name, setName] = useState(project.name);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [artifactId, setArtifactId] = useState<string | null>(null);

  const exportAudio = useExport(project.id);
  const job = useJob(jobId, { invalidateProject: true });
  const state = job.data?.state;
  const running = exportAudio.isPending || state === "pending" || state === "running";

  // Capture the artifact id from the job result once the render succeeds.
  useEffect(() => {
    if (state === "succeeded") {
      const id = job.data?.result?.artifact_id;
      if (typeof id === "string") setArtifactId(id);
    }
  }, [state, job.data?.result]);

  const trimmedName = name.trim();
  const runExport = () => {
    setArtifactId(null);
    exportAudio.mutate(
      {
        format,
        bitrate: bitrate.trim() || null,
        embed_markers: embedMarkers,
        name: trimmedName || null,
      },
      { onSuccess: (r) => setJobId(r.job_id) },
    );
  };

  const downloadUrl = artifactId ? exportDownloadUrl(project.id, artifactId) : null;
  // Fallback filename only; the backend's Content-Disposition wins on download.
  const downloadName = `${trimmedName || project.name}.${format}`;
  const noMarkers = embedMarkers && project.markers.length === 0;
  const priorExports = project.exports;

  return (
    <Modal open onClose={onClose} ariaLabel="Export audio">
      <div className="border-b border-border px-5 py-3 font-serif text-lg">Export audio</div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <Input
          label="Name"
          placeholder={project.name}
          value={name}
          disabled={running}
          onChange={(e) => setName(e.target.value)}
          hint="Used for the download filename."
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

        <Input
          label="Bitrate"
          placeholder="e.g. 192k (blank = best VBR)"
          value={bitrate}
          disabled={running}
          onChange={(e) => setBitrate(e.target.value)}
        />

        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            className="accent-accent h-4 w-4 cursor-pointer"
            checked={embedMarkers}
            disabled={running}
            onChange={(e) => setEmbedMarkers(e.target.checked)}
          />
          Embed prayer markers as chapters
        </label>

        {noMarkers && (
          <p className="text-xs text-text-tertiary">
            No markers yet — run phrase detection first, or export without chapters.
          </p>
        )}

        {running && <JobProgress job={job.data} title="Rendering…" />}

        {state === "failed" && (
          <Alert variant="error" title="Export failed">
            {job.data?.error ?? "Something went wrong while rendering."}
          </Alert>
        )}

        {downloadUrl && !running && (
          <Alert variant="success" title="Export ready">
            Your file is rendered. Download it below.
          </Alert>
        )}

        {priorExports.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <span className="text-sm font-medium text-text-secondary">Previous exports</span>
            <ul className="flex flex-col gap-1">
              {priorExports.map((ex) => (
                <li key={ex.id}>
                  <a
                    href={exportDownloadUrl(project.id, ex.id)}
                    className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm text-text hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                  >
                    <span className="truncate">{ex.name ?? project.name}</span>
                    <span className="shrink-0 text-xs uppercase text-text-tertiary">
                      {ex.format}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        {downloadUrl && !running ? (
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
