/**
 * The overview strip above the waveform: the whole recording, faint, with a gold-edged box over
 * the visible range (the engine mounts wavesurfer's Minimap plugin into it; see
 * `useWaveformEngine`). Zoom out / in sit at its right end; Ctrl/⌘ + wheel on the waveform does
 * the same.
 */
import { Button, Tooltip } from "@/components/ui";
import { zoomIn, zoomOut } from "@/features/transport/transportControls";
import { ZOOM_MAX, usePlaybackStore } from "@/stores/playbackStore";
import { Minus, Plus } from "lucide-react";
import { useWaveformContext } from "./WaveformContext";
import { OVERVIEW_HEIGHT } from "./layout";
import "./waveform.css";

function ZoomControls() {
  const { isReady } = useWaveformContext();
  const zoom = usePlaybackStore((s) => s.zoom);
  const zoomMin = usePlaybackStore((s) => s.zoomMin);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip content="Zoom out (Ctrl + wheel)">
        <Button
          size="icon"
          variant="secondary"
          disabled={!isReady || zoom == null || zoom <= zoomMin}
          onClick={zoomOut}
          aria-label="Zoom out"
        >
          <Minus size={16} />
        </Button>
      </Tooltip>
      <Tooltip content="Zoom in (Ctrl + wheel)">
        <Button
          size="icon"
          variant="secondary"
          disabled={!isReady || zoom == null || zoom >= ZOOM_MAX}
          onClick={zoomIn}
          aria-label="Zoom in"
        >
          <Plus size={16} />
        </Button>
      </Tooltip>
    </div>
  );
}

export function WaveformOverview() {
  const { overviewRef } = useWaveformContext();
  return (
    <div className="flex items-center gap-4">
      <div
        ref={overviewRef}
        role="group"
        aria-label="Recording overview"
        className="wf-overview min-w-0 flex-1"
        style={{ height: OVERVIEW_HEIGHT }}
      />
      <ZoomControls />
    </div>
  );
}
