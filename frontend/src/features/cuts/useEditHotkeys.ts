/**
 * Keyboard-driven cut editing, mounted once per editor:
 *
 * - `I` / `O`       set the in / out point of a cut at the current playhead
 * - `Delete` / `Backspace`  commit the pending in/out range as a cut
 * - `Escape`        discard the pending selection
 * - `Ctrl/Cmd+Z`    undo    `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y`  redo
 *
 * Ignored while typing in a field (so the timestamp inputs keep their native editing keys and
 * the browser's own undo). Edits route through `useEdlEditor`, so they share the single undo
 * history with the silence panel and the cut panel. The live `operations[]` and the editor are
 * read from refs to keep the key handler subscribed once while always acting on fresh state.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation } from "@/types/api";
import { useEffect, useRef } from "react";
import { addCut } from "./cutEdl";
import { useEdlEditor } from "./useEdlEditor";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useEditHotkeys(projectId: string, ops: EditOperation[]): void {
  const { wavesurfer } = useWaveformContext();
  const editor = useEdlEditor(projectId);

  const opsRef = useRef(ops);
  opsRef.current = ops;
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const store = useEditStore.getState();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) editorRef.current.redo(opsRef.current);
        else editorRef.current.undo(opsRef.current);
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        editorRef.current.redo(opsRef.current);
        return;
      }
      if (mod || e.altKey) return; // leave other modifier combos to the browser

      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        if (wavesurfer) store.setSelectionStart(wavesurfer.getCurrentTime());
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        if (wavesurfer) store.setSelectionEnd(wavesurfer.getCurrentTime());
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const { selectionStart, selectionEnd } = store;
        if (selectionStart == null || selectionEnd == null) return;
        e.preventDefault();
        editorRef.current.applyOps(
          opsRef.current,
          addCut(opsRef.current, selectionStart, selectionEnd),
        );
        store.clearSelectionRange();
      } else if (e.key === "Escape") {
        store.clearSelectionRange();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [wavesurfer]);
}
