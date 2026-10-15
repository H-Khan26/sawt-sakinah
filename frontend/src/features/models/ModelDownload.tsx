/**
 * Speech-model download UI shared by the settings modal and the Surahs column: a progress line
 * for a running download, and the first-run prompt shown where surah matching would start while
 * the model isn't on disk.
 */
import { Button, Progress } from "@/components/ui";
import { formatBytes, formatMegabytes } from "@/lib/format";
import type { SpeechModel } from "@/types/api";
import { type ModelDownloadState, useModelDownload } from "./useModelDownload";

/** Progress bar plus `33 MB of 81 MB · 41%` (indeterminate until the size is known). */
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
          ? `Downloading · ${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)} · ${Math.round(fraction * 100)}%`
          : "Starting download…"}
      </p>
    </div>
  );
}

/** First-run prompt: download the model before surahs can be found. */
export function ModelDownloadPrompt({ model }: { model: SpeechModel }) {
  const download = useModelDownload(model);
  const size = formatMegabytes(model.size_mb);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-secondary">
        Finding surahs needs the {model.label} model ({size}). It's downloaded once and then works
        offline.
      </p>
      {download.active ? (
        <ModelDownloadProgress download={download} label={`Downloading ${model.label}`} />
      ) : (
        <div>
          <Button size="sm" onClick={download.start}>
            Download the model ({size})
          </Button>
        </div>
      )}
      {download.failed && <p className="text-sm text-danger">Download failed: {download.error}</p>}
    </div>
  );
}
