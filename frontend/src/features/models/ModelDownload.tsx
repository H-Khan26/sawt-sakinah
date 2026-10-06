/**
 * Speech-model download UI shared by the settings modal and the phrase-detection panel: a
 * progress line for a running download, and the first-run prompt shown where phrase detection
 * would start while the selected model isn't on disk.
 */
import { Button, Progress } from "@/components/ui";
import { formatBytes, formatMegabytes } from "@/lib/format";
import type { SpeechModel } from "@/types/api";
import { type ModelDownloadState, useModelDownload } from "./useModelDownload";

/** Progress bar plus `420 MB of 1.6 GB · 26%` (indeterminate until the size is known). */
export function ModelDownloadProgress({
  download,
  label,
}: {
  download: ModelDownloadState;
  label: string;
}) {
  const { bytesDone, bytesTotal, fraction } = download;
  return (
    <div className="flex flex-col gap-1.5">
      <Progress value={fraction} label={label} />
      <p className="text-xs tabular-nums text-text-tertiary">
        {fraction !== null && bytesDone !== null && bytesTotal !== null
          ? `${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)} · ${Math.round(fraction * 100)}%`
          : "Starting download…"}
      </p>
    </div>
  );
}

/** First-run prompt: download the selected model before phrase detection can run. */
export function ModelDownloadPrompt({ model }: { model: SpeechModel }) {
  const download = useModelDownload(model);
  const size = formatMegabytes(model.size_mb);

  return (
    <div className="flex flex-col gap-3 rounded border border-border bg-background-secondary/40 p-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-text">Phrase detection needs a speech model</p>
        <p className="text-sm text-text-secondary">
          {model.label} is a one-time {size} download. Silence detection and editing work without
          it.
        </p>
      </div>
      {download.active ? (
        <ModelDownloadProgress download={download} label={`Downloading ${model.label}`} />
      ) : (
        <div>
          <Button size="sm" onClick={download.start}>
            Download speech model ({size})
          </Button>
        </div>
      )}
      {download.failed && <p className="text-sm text-danger">Download failed: {download.error}</p>}
    </div>
  );
}
