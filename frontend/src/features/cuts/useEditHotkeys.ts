/**
 * Keyboard-driven cut editing, mounted once per editor:
 *
 * - `I` / `O`       set the in / out point of a cut at the current playhead
 * - `Delete` / `Backspace`  cut the pending in/out range (nothing without one)
 * - `R`             restore the cut audio in the pending range, else the selected cut range
 * - `,` / `.`       move the playhead to the previous / next cut
 * - `Escape`        discard the pending selection and deselect the cut range
 * - `Ctrl/Cmd+Z`    undo    `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y`  redo
 *
 * Ignored while typing in a field (so the timestamp inputs keep their native editing keys and
 * the browser's own undo). Edits route through `useEdlEditor` (the cut and restore actions via
 * `useCutCommands`), so they share the single undo history with the silence panel and the cut
 * panel, and build on the latest edit even while it is still saving. The editor and commands
 * are read from a ref to keep the key handler subscribed once.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useEditStore } from "@/stores/editStore";
import { useEffect, useRef } from "react";
import { useCutCommands } from "./useCutCommands";
import { useEdlEditor } from "./useEdlEditor";

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useEditHotkeys(projectId: string): void {
  const { controller } = useWaveformContext();
  const editor = useEdlEditor(projectId);
  const commands = useCutCommands(projectId);

  const latest = useRef({ editor, commands });
  latest.current = { editor, commands };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const store = useEditStore.getState();
      const { editor, commands } = latest.current;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        editor.redo();
        return;
      }
      if (mod || e.altKey) return; // leave other modifier combos to the browser

      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        store.setSelectionStart(controller.getSourceTime());
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        store.setSelectionEnd(controller.getSourceTime());
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (commands.cut()) e.preventDefault();
      } else if (e.key === "r" || e.key === "R") {
        if (commands.restore()) e.preventDefault();
      } else if (e.key === "," || e.key === ".") {
        e.preventDefault();
        commands.stepCut(e.key === "," ? -1 : 1);
      } else if (e.key === "Escape") {
        store.clearSelectionRange();
        store.selectCut(null);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);
}
