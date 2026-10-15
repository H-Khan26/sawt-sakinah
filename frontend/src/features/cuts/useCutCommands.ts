/**
 * The cut tool's actions, shared by the Cut panel's buttons, the keyboard and the waveform: cut
 * or restore the pending selection, restore the selected cut range or a seam's whole range,
 * commit an edge drag of a cut range, and step the playhead between cuts. Each reads the live
 * EDL, the selection and the playhead when it runs, so callers subscribe to nothing for them.
 * Edits go through `useEdlEditor` and carry an undo label naming the audio they change
 * ("Restore 2.1 s").
 *
 * A cut range is selected only while deleted audio is shown (the full view), where it is drawn
 * with edge handles; in the collapsed view it has no extent on screen, so a selected one is
 * ignored there.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { type Span, coveredDuration, spanTotal, subtractSpans } from "@/lib/edl";
import { useEditStore } from "@/stores/editStore";
import {
  MIN_CUT_DURATION,
  cutKey,
  cutRange,
  cutRanges,
  durationLabel,
  restoreRange,
  restoreRanges,
} from "./cutEdl";
import { cutSpansOf } from "./cutModel";
import { adjacentSeam, cutSeams } from "./seams";
import { cutGain, pendingSpan, restoreTarget, selectedCutSpan } from "./selection";
import { useEdlEditor } from "./useEdlEditor";

export interface CutCommands {
  /** Cut the pending selection; false when there is none or it is already cut. */
  cut: () => boolean;
  /** Restore the cut audio under the pending selection, else the selected cut range. */
  restore: () => boolean;
  /** Restore the cut audio in `span` (a seam's whole range); false when there is none. */
  restoreCut: (span: Span) => boolean;
  /**
   * Commit a drag of the `side` edge of the cut range keyed `key` to source time `time`: audio
   * the range no longer covers is restored, audio it newly covers is cut. Selects the resulting
   * range; false when nothing changed.
   */
  resizeCut: (key: string, side: "start" | "end", time: number) => boolean;
  /** Move the playhead to the previous (`-1`) or next (`1`) cut, selecting it in the full view. */
  stepCut: (direction: -1 | 1) => void;
}

export function useCutCommands(projectId: string): CutCommands {
  const { controller, timeMap } = useWaveformContext();
  const editor = useEdlEditor(projectId);
  const cutSpans = () => cutSpansOf(editor.liveOps());

  return {
    cut: () => {
      const store = useEditStore.getState();
      const span = pendingSpan(store.selectionStart, store.selectionEnd);
      if (!span) return false;
      const gain = cutGain(cutSpans(), span);
      if (gain < MIN_CUT_DURATION) return false;
      editor.apply((ops) => cutRange(ops, span[0], span[1]), durationLabel("Cut", gain));
      store.clearSelectionRange();
      return true;
    },

    restore: () => {
      const store = useEditStore.getState();
      const spans = cutSpans();
      const selectedCut = timeMap.identity ? selectedCutSpan(spans, store.selectedIds) : null;
      const target = restoreTarget(
        spans,
        pendingSpan(store.selectionStart, store.selectionEnd),
        selectedCut,
      );
      if (!target) return false;
      const [a, b] = target.span;
      editor.apply((ops) => restoreRange(ops, a, b), durationLabel("Restore", target.seconds));
      if (target.pending) store.clearSelectionRange();
      else store.selectCut(null);
      return true;
    },

    restoreCut: ([a, b]) => {
      const seconds = coveredDuration(cutSpans(), a, b);
      if (seconds < MIN_CUT_DURATION) return false;
      return !!editor.apply((ops) => restoreRange(ops, a, b), durationLabel("Restore", seconds));
    },

    resizeCut: (key, side, time) => {
      const spans = cutSpans();
      const from = spans.find((span) => cutKey(span) === key);
      if (!from) return false;
      // Only the dragged edge moves; the other keeps the range's own bound.
      const to: Span =
        side === "start" ? [Math.min(time, from[1]), from[1]] : [from[0], Math.max(time, from[0])];
      const restored = subtractSpans([from], [to]);
      const added = subtractSpans([to], [from]);
      // A nudge shorter than a cut (the grips move from the first pixel) changes nothing.
      const restoring = spanTotal(restored) >= MIN_CUT_DURATION;
      if (!restoring && spanTotal(added) < MIN_CUT_DURATION) return false;
      const label = restoring
        ? durationLabel("Restore", spanTotal(restored))
        : durationLabel(
            "Cut",
            added.reduce((sum, span) => sum + cutGain(spans, span), 0),
          );
      const done = editor.apply((ops) => cutRanges(restoreRanges(ops, restored), added), label);
      if (!done) return false;
      // The range's key names its bounds, so select whatever range now covers the dragged span.
      const next = cutSpans().find(([a, b]) => a < to[1] && to[0] < b);
      useEditStore.getState().selectCut(next ? cutKey(next) : null);
      return true;
    },

    stepCut: (direction) => {
      const at = timeMap.toEdited(controller.getSourceTime());
      const seams = cutSeams(cutSpans(), timeMap);
      const seam = adjacentSeam(seams, at, direction, controller.isPlaying());
      if (!seam) return;
      controller.setSourceTime(seam.span[0]);
      if (timeMap.identity) useEditStore.getState().selectCut(cutKey(seam.span));
    },
  };
}
