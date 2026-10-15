import { Progress } from "@/components/ui";
import type { JobRecord } from "@/types/api";

export interface JobProgressProps {
  job: JobRecord | undefined;
  /** Headline shown above the bar (e.g. "Extracting audio"). */
  title?: string;
}

/** Coerce an unknown progress-dict value to a finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Human label for the yt-dlp `eta` (seconds) field, when present. */
function etaLabel(eta: number | null): string | null {
  if (eta === null || eta <= 0) return null;
  if (eta < 60) return `about ${Math.round(eta)}s left`;
  return `about ${Math.round(eta / 60)}m left`;
}

/** Readable text for the stages jobs report; others show as sent. */
const STAGE_TEXT: Record<string, string> = {
  transcribing: "Transcribing",
  matching: "Matching",
  detect: "Detecting",
  export: "Rendering",
  render: "Rendering",
  import: "Importing",
  downloading: "Downloading",
};

/**
 * Renders a job's `progress` dict, handling the shapes emitted by the backend (workers.py): the
 * yt-dlp extraction hook (`status`, `downloaded_bytes`, `total_bytes`, `eta`), the
 * `{ stage, status }` payload of detection/export jobs, and surah matching's
 * `{ stage, done_sec, total_sec }`. Determinate when a byte or seconds ratio is available;
 * indeterminate otherwise.
 */
export function JobProgress({ job, title }: JobProgressProps) {
  const progress = job?.progress ?? {};

  const downloaded = num(progress.downloaded_bytes);
  const total = num(progress.total_bytes) ?? num(progress.total_bytes_estimate);
  const doneSec = num(progress.done_sec);
  const totalSec = num(progress.total_sec);
  const ratio =
    downloaded !== null && total !== null && total > 0
      ? downloaded / total
      : doneSec !== null && totalSec !== null && totalSec > 0
        ? Math.min(1, doneSec / totalSec)
        : null;

  const rawStage = typeof progress.stage === "string" ? progress.stage : null;
  const stage = rawStage ? (STAGE_TEXT[rawStage] ?? rawStage) : null;
  const status = typeof progress.status === "string" ? progress.status : null;
  const eta = etaLabel(num(progress.eta));

  // Prefer the stage/status text; fall back to the raw status; then a generic line.
  const detail = [stage, status].filter(Boolean).join(" · ") || eta || "Working…";

  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      {title && <p className="font-serif text-lg text-text">{title}</p>}
      <Progress value={ratio} label={title ?? "Job progress"} />
      <p className="text-sm text-text-tertiary">
        {detail}
        {ratio !== null && ` · ${Math.round(ratio * 100)}%`}
      </p>
    </div>
  );
}
