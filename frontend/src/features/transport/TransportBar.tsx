/**
 * Transport controls: play/pause, current-time readout, zoom, and playback rate.
 *
 * Each control subscribes to the *narrowest* `playbackStore` slice it needs. In particular
 * `TimeReadout` is split out and subscribes only to `currentTime`/`duration`, so the
 * per-frame time updates re-render just that small node — not the transport bar or the
 * editor tree.
 */
import { Button } from "@/components/ui";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { formatClock } from "@/lib/time";
import { PLAYBACK_RATES, ZOOM_MAX, ZOOM_MIN, usePlaybackStore } from "@/stores/playbackStore";
import { togglePlay, zoomIn, zoomOut } from "./transportControls";

function TimeReadout() {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  return (
    <output className="min-w-[7.5rem] font-sans text-sm tabular-nums text-text-secondary">
      {formatClock(currentTime)} <span className="text-text-tertiary">/</span>{" "}
      {formatClock(duration)}
    </output>
  );
}

function PlayButton() {
  const { wavesurfer, isReady } = useWaveformContext();
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  return (
    <Button
      size="sm"
      variant="primary"
      disabled={!isReady}
      onClick={() => togglePlay(wavesurfer)}
      aria-label={isPlaying ? "Pause" : "Play"}
      aria-pressed={isPlaying}
    >
      {isPlaying ? "Pause" : "Play"}
    </Button>
  );
}

function ZoomControls() {
  const { isReady } = useWaveformContext();
  const zoom = usePlaybackStore((s) => s.zoom);
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={!isReady || zoom == null || zoom <= ZOOM_MIN}
        onClick={zoomOut}
        aria-label="Zoom out"
      >
        −
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!isReady || zoom == null || zoom >= ZOOM_MAX}
        onClick={zoomIn}
        aria-label="Zoom in"
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
    <label className="flex items-center gap-1.5 font-sans text-sm text-text-secondary">
      Speed
      <select
        value={rate}
        disabled={!isReady}
        onChange={(e) => setRate(Number(e.target.value))}
        className="h-8 rounded border border-border bg-background px-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50"
      >
        {PLAYBACK_RATES.map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
    </label>
  );
}

export function TransportBar() {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-background px-4 py-2.5">
      <PlayButton />
      <TimeReadout />
      <div className="ml-auto flex items-center gap-4">
        <ZoomControls />
        <RateSelect />
      </div>
    </div>
  );
}
