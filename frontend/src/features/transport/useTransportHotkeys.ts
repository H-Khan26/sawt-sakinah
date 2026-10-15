import { isTypingTarget } from "@/features/cuts/useEditHotkeys";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
/**
 * Global transport shortcuts: Space = play/pause, ArrowLeft / ArrowRight = skip back / forward
 * 5s. Ignored while the user is typing in a form field or contenteditable so the keys keep their
 * normal meaning there. Reads the live instance from the waveform context. Zoom is Ctrl/⌘ +
 * wheel on the waveform; `[` / `]` step through surah passages (see `useSurahHotkeys`).
 */
import { useEffect } from "react";
import { SEEK_STEP_SEC, seekBy, togglePlay } from "./transportControls";

export function useTransportHotkeys(): void {
  const { controller } = useWaveformContext();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Keys a focused control already handled (e.g. arrows moving between tabs) are not seeks.
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay(controller);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekBy(controller, SEEK_STEP_SEC);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekBy(controller, -SEEK_STEP_SEC);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);
}
