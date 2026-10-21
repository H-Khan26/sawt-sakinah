/**
 * Transport row: back 5 s, play/pause (a round accent button inside a gold ring), forward 5 s,
 * the clock, and the playback speed beside it; undo/redo, the copy-timestamp button, the
 * snapping toggle and the show-deleted toggle sit at the right. Zoom belongs to the overview.
 *
 * Each control subscribes to the *narrowest* `playbackStore` slice it needs. In particular
 * `Clock` subscribes only to `currentTime`/`duration`, so the per-frame time updates re-render
 * just that small node — not the transport row or the editor tree.
 */
import { Button, Tooltip } from "@/components/ui";
import { UndoRedoControls } from "@/features/cuts/UndoRedoControls";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { formatClockPrecise, formatHms } from "@/lib/time";
import { PLAYBACK_RATES, usePlaybackStore } from "@/stores/playbackStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { ProjectView } from "@/types/api";
import {
  Check,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Eye,
  EyeOff,
  Magnet,
  Pause,
  Play,
} from "lucide-react";
import { useState } from "react";
import { SEEK_STEP_SEC, seekBy, togglePlay } from "./transportControls";

function Clock() {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const duration = usePlaybackStore((s) => s.duration);
  return (
    <output className="flex items-baseline gap-2.5 whitespace-nowrap">
      <span className="min-w-[4.5ch] font-display text-[30px] leading-none tabular-nums text-text">
        {formatClockPrecise(currentTime)}
      </span>
      <span className="text-sm tabular-nums text-text-secondary">of {formatHms(duration)}</span>
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
        size="icon"
        variant="ghost"
        onClick={onCopy}
        aria-label={copied ? "Timestamp copied" : "Copy current timestamp"}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </Button>
    </Tooltip>
  );
}

function SkipButton({ direction }: { direction: -1 | 1 }) {
  const { controller, isReady } = useWaveformContext();
  const label =
    direction < 0 ? `Back ${SEEK_STEP_SEC} seconds` : `Forward ${SEEK_STEP_SEC} seconds`;
  return (
    <Tooltip content={`${label} (${direction < 0 ? "←" : "→"})`}>
      <Button
        size="icon"
        variant="secondary"
        disabled={!isReady}
        onClick={() => seekBy(controller, direction * SEEK_STEP_SEC)}
        aria-label={label}
        className="!h-10 !w-10 !rounded-full"
      >
        {direction < 0 ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}
      </Button>
    </Tooltip>
  );
}

function PlayButton() {
  const { controller, isReady } = useWaveformContext();
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  return (
    <Tooltip content={isPlaying ? "Pause (Space)" : "Play (Space)"}>
      <Button
        variant="primary"
        disabled={!isReady}
        onClick={() => togglePlay(controller)}
        aria-label={isPlaying ? "Pause" : "Play"}
        aria-pressed={isPlaying}
        className="!h-14 !w-14 !rounded-full !px-0 outline outline-2 outline-offset-[3px] outline-gold"
      >
        {isPlaying ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} fill="currentColor" className="translate-x-px" />
        )}
      </Button>
    </Tooltip>
  );
}

/** Toggle whether deleted (cut) audio is shown on the waveform. Off = collapsed edited view. */
function ViewToggle() {
  const showDeleted = useViewPrefs((s) => s.showDeleted);
  const toggle = useViewPrefs((s) => s.toggleShowDeleted);
  const label = showDeleted ? "Hide deleted audio" : "Show deleted audio";
  return (
    <Tooltip content={label}>
      <Button
        size="icon"
        variant="ghost"
        onClick={toggle}
        aria-label={label}
        aria-pressed={showDeleted}
      >
        {showDeleted ? <Eye size={18} /> : <EyeOff size={18} />}
      </Button>
    </Tooltip>
  );
}

/** The Alt key's name on this platform: Option on a Mac. */
const ALT_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Option" : "Alt";

/** Toggle whether clicks and drags on the waveform latch on to nearby surah and cut edges. */
function SnapToggle() {
  const snapEdges = useViewPrefs((s) => s.snapEdges);
  const toggle = useViewPrefs((s) => s.toggleSnapEdges);
  const label = snapEdges ? "Stop snapping to edges" : "Snap to surah and cut edges";
  return (
    <Tooltip content={snapEdges ? `${label} (hold ${ALT_KEY} to place freely)` : label}>
      <Button
        size="icon"
        variant="ghost"
        onClick={toggle}
        aria-label={label}
        aria-pressed={snapEdges}
        className={snapEdges ? undefined : "text-text-tertiary"}
      >
        <Magnet size={18} />
      </Button>
    </Tooltip>
  );
}

function RateSelect() {
  const { isReady } = useWaveformContext();
  const rate = usePlaybackStore((s) => s.rate);
  const setRate = usePlaybackStore((s) => s.setRate);
  return (
    <select
      value={rate}
      disabled={!isReady}
      onChange={(e) => setRate(Number(e.target.value))}
      aria-label="Playback speed"
      className="h-9 cursor-pointer rounded-full border border-border bg-surface px-3.5 text-sm text-text hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50"
    >
      {PLAYBACK_RATES.map((r) => (
        <option key={r} value={r}>
          {r}× speed
        </option>
      ))}
    </select>
  );
}

export function TransportBar({ project }: { project: ProjectView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex items-center gap-3">
        <SkipButton direction={-1} />
        <PlayButton />
        <SkipButton direction={1} />
      </div>
      <div className="flex items-center gap-5">
        <Clock />
        <RateSelect />
      </div>
      <div className="ml-auto flex items-center gap-1">
        <UndoRedoControls projectId={project.id} />
        <CopyTimeButton />
        <SnapToggle />
        <ViewToggle />
      </div>
    </div>
  );
}
