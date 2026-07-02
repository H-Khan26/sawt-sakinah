/**
 * Transport controls: play/pause, current-time readout, zoom, and playback rate.
 *
 * Each control subscribes to the *narrowest* `playbackStore` slice it needs. In particular
 * `TimeReadout` is split out and subscribes only to `currentTime`/`duration`, so the
 * per-frame time updates re-render just that small node — not the transport bar or the
 * editor tree.
 */
import { Button, Tooltip } from "@/components/ui";
import { UndoRedoControls } from "@/features/cuts/UndoRedoControls";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { formatClock, formatClockPrecise } from "@/lib/time";
import { PLAYBACK_RATES, ZOOM_MAX, usePlaybackStore } from "@/stores/playbackStore";
import type { ProjectView } from "@/types/api";
import { Check, Copy, Pause, Play } from "lucide-react";
import { useState } from "react";
import { togglePlay, zoomIn, zoomOut } from "./transportControls";

function TimeReadout() {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  return (
    <output className="min-w-[5rem] font-sans text-base tabular-nums text-text-secondary">
      {formatClock(currentTime)} <span className="text-text-tertiary">/</span>{" "}
      {formatClock(duration)}
    </output>
  );
}

/** Copy the current playhead timestamp (precise, `m:ss.s`) to the clipboard. */
function CopyTimeButton() {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const t = formatClockPrecise(usePlaybackStore.getState().currentTime);
    try {
      await navigator.clipboard.writeText(t);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard may be unavailable (insecure context); silently ignore.
    }
  };
  return (
    <Tooltip content={copied ? "Copied!" : "Copy timestamp"}>
      <Button
        size="sm"
        variant="ghost"
        onClick={onCopy}
        aria-label={copied ? "Timestamp copied" : "Copy current timestamp"}
        className="h-9 w-9 px-0"
      >
        {copied ? <Check size={20} /> : <Copy size={20} />}
      </Button>
    </Tooltip>
  );
}

function PlayButton() {
  const { wavesurfer, isReady } = useWaveformContext();
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  return (
    <Tooltip content={isPlaying ? "Pause" : "Play"}>
      <Button
        size="sm"
        variant="primary"
        disabled={!isReady}
        onClick={() => togglePlay(wavesurfer)}
        aria-label={isPlaying ? "Pause" : "Play"}
        aria-pressed={isPlaying}
        className="h-9 w-9 px-0"
      >
        {isPlaying ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} fill="currentColor" />
        )}
      </Button>
    </Tooltip>
  );
}

function ZoomControls() {
  const { isReady } = useWaveformContext();
  const zoom = usePlaybackStore((s) => s.zoom);
  const zoomMin = usePlaybackStore((s) => s.zoomMin);
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={!isReady || zoom == null || zoom <= zoomMin}
        onClick={zoomOut}
        aria-label="Zoom out"
        className="h-9 text-base"
      >
        −
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!isReady || zoom == null || zoom >= ZOOM_MAX}
        onClick={zoomIn}
        aria-label="Zoom in"
        className="h-9 text-base"
      >
        +
      </Button>
    </div>
  );
}

function RateSelect() {
  const { isReady } = useWaveformContext();
  const rate = usePlaybackStore((s) => s.rate);
  const setRate = usePlaybackStore((s) => s.setRate);
  return (
    <Tooltip content="Playback speed">
      <select
        value={rate}
        disabled={!isReady}
        onChange={(e) => setRate(Number(e.target.value))}
        aria-label="Playback speed"
        className="h-9 rounded border border-border bg-background px-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50"
      >
        {PLAYBACK_RATES.map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
    </Tooltip>
  );
}

export function TransportBar({ project }: { project: ProjectView }) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-3">
      <PlayButton />
      <div className="flex items-center gap-1.5">
        <TimeReadout />
        <CopyTimeButton />
      </div>
      <div className="ml-auto flex items-center gap-4">
        <UndoRedoControls projectId={project.id} ops={project.edl.operations} />
        <ZoomControls />
        <RateSelect />
      </div>
    </div>
  );
}
