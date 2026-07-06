import { useWaveformContext } from "@/features/waveform/WaveformContext";
/**
 * Global transport shortcuts: Space = play/pause, `[` / `]` = zoom out / in,
 * ArrowLeft / ArrowRight = skip back / forward 5s. Ignored while the user is typing in a
 * form field or contenteditable so the keys keep their normal meaning there. Reads the live
 * instance from the waveform context.
 */
import { useEffect } from "react";
import { SEEK_STEP_SEC, seekBy, togglePlay, zoomIn, zoomOut } from "./transportControls";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useTransportHotkeys(): void {
  const { wavesurfer } = useWaveformContext();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay(wavesurfer);
      } else if (e.key === "]") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "[") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekBy(wavesurfer, SEEK_STEP_SEC);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekBy(wavesurfer, -SEEK_STEP_SEC);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [wavesurfer]);
}
