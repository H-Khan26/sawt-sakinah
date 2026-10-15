/**
 * Cut editing: mark a range by playhead (I/O keys), by typing timestamps or by dragging on the
 * waveform, then cut it (a union with the removed audio), restore the cut audio inside it (a
 * subtraction), or keep only it. A cut range selected on the waveform (full view) can be restored
 * whole too. Below, a one-line tally of the removed ranges steps the playhead between them.
 * Shares the EDL and the undo history with the silence tool via `useEdlEditor`; the actions
 * themselves live in `useCutCommands`, shared with the keyboard. Nothing is rendered
 * destructively until export, and the waveform engine skips cut ranges live during playback.
 */
import { Button, Tooltip } from "@/components/ui";
import { FieldLabel } from "@/features/editor/FieldLabel";
import { ExportModal } from "@/features/export/ExportModal";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import type { TimeMap } from "@/features/waveform/timeMap";
import { formatClockPrecise, parseClock } from "@/lib/time";
import { useEditStore } from "@/stores/editStore";
import type { ProjectView } from "@/types/api";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SplitModal } from "./SplitModal";
import { MIN_CUT_DURATION, keepOnly } from "./cutEdl";
import { useCutModel } from "./cutModel";
import { cutGain, pendingSpan, restoreTarget, selectedCutSpan } from "./selection";
import { useCutCommands } from "./useCutCommands";
import { isTypingTarget } from "./useEditHotkeys";
import { useEdlEditor } from "./useEdlEditor";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const INPUT_CLASS =
  "h-9 w-28 rounded border border-border bg-surface px-2.5 text-sm tabular-nums text-text " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus";

/**
 * A timestamp text field bound to a nullable seconds value. The stored value is *source* time,
 * but the field shows and accepts *edited* time (matching the ruler and the playhead readout) —
 * `timeMap` projects on display and inverts on commit, so the selection stays source-authored.
 * Commits on every valid keystroke (live selection preview) and re-syncs its text when the
 * displayed value changes externally (the I/O keys, or a view toggle), without clobbering what
 * the user is mid-typing.
 */
function TimeInput({
  id,
  value,
  timeMap,
  onCommit,
  ariaLabel,
}: {
  id: string;
  value: number | null;
  timeMap: TimeMap;
  onCommit: (t: number | null) => void;
  ariaLabel: string;
}) {
  const display = value == null ? null : timeMap.toEdited(value);
  const [text, setText] = useState(display == null ? "" : formatClockPrecise(display));
  const lastDisplay = useRef(display);

  useEffect(() => {
    if (display !== lastDisplay.current) {
      lastDisplay.current = display;
      setText(display == null ? "" : formatClockPrecise(display));
    }
  }, [display]);

  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      className={INPUT_CLASS}
      value={text}
      placeholder="m:ss.s"
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === "") {
          lastDisplay.current = null;
          onCommit(null);
          return;
        }
        const parsed = parseClock(next);
        if (parsed != null) {
          lastDisplay.current = parsed;
          onCommit(timeMap.toSource(parsed));
        }
      }}
    />
  );
}

function Key({ k }: { k: string }) {
  return (
    <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-sans text-[0.7rem] text-text">
      {k}
    </kbd>
  );
}

/** The cut tool's shortcuts, as one wrapping line of key caps. */
function KeyHints() {
  const hints: [string, string][] = [
    ["I", "start"],
    ["O", "end"],
    ["Del", "cut"],
    ["R", "restore"],
    ["K", "keep only"],
    ["E", "export"],
    ["N", "new recording"],
  ];
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-tertiary">
      {hints.map(([k, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <Key k={k} /> {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <Key k="," /> <Key k="." /> previous / next cut
      </span>
    </p>
  );
}

/**
 * The removed audio in one line — how many merged ranges and how long, silence removals
 * included — with buttons that step the playhead to the previous / next cut.
 */
function CutSummary({
  cuts,
  removed,
  disabled,
  onStep,
}: {
  /** Number of merged cut ranges. */
  cuts: number;
  /** Seconds they remove. */
  removed: number;
  disabled: boolean;
  onStep: (direction: -1 | 1) => void;
}) {
  const none = cuts === 0;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-dotted border-border pt-4 text-sm text-text-secondary">
      <p className="tabular-nums">
        {none ? (
          "Nothing cut yet."
        ) : (
          <>
            <span className="text-text">{plural(cuts, "cut", "cuts")}</span> ·{" "}
            {formatClockPrecise(removed)} removed
          </>
        )}
      </p>
      <div className="flex items-center gap-1">
        <Tooltip content="Previous cut (,)">
          <Button
            size="icon"
            variant="ghost"
            disabled={disabled || none}
            onClick={() => onStep(-1)}
            aria-label="Previous cut"
          >
            <ChevronLeft size={18} />
          </Button>
        </Tooltip>
        <Tooltip content="Next cut (.)">
          <Button
            size="icon"
            variant="ghost"
            disabled={disabled || none}
            onClick={() => onStep(1)}
            aria-label="Next cut"
          >
            <ChevronRight size={18} />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

export function CutPanel({ project }: { project: ProjectView }) {
  const projectId = project.id;

  const { controller, timeMap, isReady } = useWaveformContext();
  const editor = useEdlEditor(projectId);
  const commands = useCutCommands(projectId);

  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const setSelectionStart = useEditStore((s) => s.setSelectionStart);
  const setSelectionEnd = useEditStore((s) => s.setSelectionEnd);
  const clearSelectionRange = useEditStore((s) => s.clearSelectionRange);
  const selectedIds = useEditStore((s) => s.selectedIds);

  const [exportOpen, setExportOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  const duration = project.audio_source.duration_sec;
  const { cutSpans, removedSeconds } = useCutModel(project);

  // Normalized source-time selection, or null when no valid range is marked.
  const pending = pendingSpan(selectionStart, selectionEnd);
  const rangeReady = pending != null;
  const range = pending ? { start: pending[0], end: pending[1] } : null;

  // A selection over a seam (collapsed) or over hatched audio (full view) covers cut audio:
  // Cut removes only what isn't cut yet, and Restore brings the cut part back.
  const gain = pending ? cutGain(cutSpans, pending) : 0;
  const canCut = gain >= MIN_CUT_DURATION;
  const partlyCut = pending != null && pending[1] - pending[0] - gain >= MIN_CUT_DURATION;
  const restore = restoreTarget(
    cutSpans,
    pending,
    timeMap.identity ? selectedCutSpan(cutSpans, selectedIds) : null,
  );

  const cutTitle =
    pending && !canCut
      ? "The selection is already cut"
      : partlyCut
        ? `Cut the ${gain.toFixed(1)} s not cut yet (Delete)`
        : "Cut the range (Delete)";
  const restoreTitle = !restore
    ? "Select cut audio to restore it (R)"
    : restore.pending
      ? "Restore the cut audio in the selection (R)"
      : "Restore the selected cut (R)";

  const keepOnlyRange = () => {
    if (!range) return;
    editor.apply((o) => keepOnly(o, range.start, range.end, duration), "Keep only");
    clearSelectionRange();
  };

  // Selection-action shortcuts (E export, N new recording, K keep-only), co-located here since the
  // range + modal state live in this component. Read via a ref so the listener subscribes once
  // while acting on fresh state; suppressed while typing or while a selection modal is open.
  const hotkeyRef = useRef({ keepOnlyRange, setExportOpen, setSplitOpen, rangeReady });
  hotkeyRef.current = { keepOnlyRange, setExportOpen, setSplitOpen, rangeReady };
  const modalOpen = exportOpen || splitOpen;
  useEffect(() => {
    if (modalOpen) return; // don't fire selection shortcuts while a dialog is up
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const h = hotkeyRef.current;
      if (!h.rangeReady) return;
      const k = e.key.toLowerCase();
      if (k === "e") {
        e.preventDefault();
        h.setExportOpen(true);
      } else if (k === "n") {
        e.preventDefault();
        h.setSplitOpen(true);
      } else if (k === "k") {
        e.preventDefault();
        h.keepOnlyRange();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modalOpen]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label htmlFor="cut-start" className="flex flex-col gap-1.5">
          <FieldLabel>Start</FieldLabel>
          <TimeInput
            id="cut-start"
            value={selectionStart}
            timeMap={timeMap}
            onCommit={setSelectionStart}
            ariaLabel="Cut start"
          />
        </label>
        <label htmlFor="cut-end" className="flex flex-col gap-1.5">
          <FieldLabel>End</FieldLabel>
          <TimeInput
            id="cut-end"
            value={selectionEnd}
            timeMap={timeMap}
            onCommit={setSelectionEnd}
            ariaLabel="Cut end"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSelectionStart(controller.getSourceTime())}
            disabled={!isReady}
            title="Set start to the playhead (I)"
          >
            Set in
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSelectionEnd(controller.getSourceTime())}
            disabled={!isReady}
            title="Set end to the playhead (O)"
          >
            Set out
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelectionRange}
            disabled={selectionStart == null && selectionEnd == null}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Selection actions: operate on the marked range. Enabled only when it's valid. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-dotted border-border pt-4">
        <Button onClick={commands.cut} disabled={!canCut} title={cutTitle}>
          Cut range
        </Button>
        <Button
          variant="secondary"
          onClick={commands.restore}
          disabled={!restore}
          title={restoreTitle}
          className="tabular-nums"
        >
          {restore ? `Restore ${restore.seconds.toFixed(1)} s` : "Restore"}
        </Button>
        <Button
          variant="secondary"
          onClick={keepOnlyRange}
          disabled={!rangeReady}
          title="Trim everything outside the selection (K)"
        >
          Keep only
        </Button>
        <Button
          variant="secondary"
          onClick={() => setExportOpen(true)}
          disabled={!rangeReady}
          title="Export the selection as an audio file (E)"
        >
          Export selection…
        </Button>
        <Button
          variant="secondary"
          onClick={() => setSplitOpen(true)}
          disabled={!rangeReady}
          title="Create a new recording from the selection (N)"
        >
          New recording…
        </Button>
      </div>

      <KeyHints />

      <CutSummary
        cuts={cutSpans.length}
        removed={removedSeconds}
        disabled={!isReady}
        onStep={commands.stepCut}
      />

      {exportOpen && range && (
        <ExportModal project={project} range={range} onClose={() => setExportOpen(false)} />
      )}
      {splitOpen && range && (
        <SplitModal project={project} range={range} onClose={() => setSplitOpen(false)} />
      )}
    </div>
  );
}
