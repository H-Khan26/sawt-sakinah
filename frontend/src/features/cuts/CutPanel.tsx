/**
 * Manual cut editing: mark a range by playhead (I/O keys) or by typing timestamps, commit it
 * as a non-destructive `cut`, and manage committed cuts (restore = uncut). Shares the EDL and
 * the undo history with the silence panel via `useEdlEditor`; nothing is rendered destructively
 * until export, and playback skips committed cuts live (see `useCutSkip`).
 */
import { Button, Card } from "@/components/ui";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { cn } from "@/lib/cn";
import { cutColors, selectionColors, silenceColors } from "@/lib/themeColors";
import { formatClock, formatClockPrecise, parseClock } from "@/lib/time";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation, ProjectView } from "@/types/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { MIN_CUT_DURATION, addCut, cutKey, manualCuts, removeCutsByKey } from "./cutEdl";
import { useEdlEditor } from "./useEdlEditor";

const INPUT_CLASS =
  "h-8 w-24 rounded border border-border bg-background px-2 text-sm tabular-nums text-text " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus";

/**
 * A timestamp text field bound to a nullable seconds value. Commits on every valid keystroke
 * (live selection preview) and re-syncs its text when the value changes externally (the I/O
 * keys), without clobbering what the user is mid-typing.
 */
function TimeInput({
  id,
  value,
  onCommit,
  ariaLabel,
}: {
  id: string;
  value: number | null;
  onCommit: (t: number | null) => void;
  ariaLabel: string;
}) {
  const [text, setText] = useState(value == null ? "" : formatClockPrecise(value));
  const lastValue = useRef(value);

  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setText(value == null ? "" : formatClockPrecise(value));
    }
  }, [value]);

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
          lastValue.current = null;
          onCommit(null);
          return;
        }
        const parsed = parseClock(next);
        if (parsed != null) {
          lastValue.current = parsed;
          onCommit(parsed);
        }
      }}
    />
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
      {label}
    </span>
  );
}

function EditLegend() {
  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-background-secondary/40 p-3 text-xs text-text-secondary">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>Click the waveform to play from / seek there. Mark a range, then cut:</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Key k="I" /> set start
        <Key k="O" /> set end
        <Key k="Del" /> cut range
        <span className="text-text-tertiary">·</span>
        <Key k="Ctrl+Z" /> undo
        <Key k="Ctrl+Shift+Z" /> redo
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-text-tertiary">
        <Swatch color={selectionColors.fill} label="pending range" />
        <Swatch color={cutColors.fillSelected} label="cut" />
        <Swatch color={silenceColors.fillSelected} label="silence" />
      </div>
    </div>
  );
}

function Key({ k }: { k: string }) {
  return (
    <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-sans text-[0.7rem] text-text">
      {k}
    </kbd>
  );
}

export function CutPanel({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const ops = project.edl.operations;
  const silences = project.silences;

  const { wavesurfer } = useWaveformContext();
  const editor = useEdlEditor(projectId);

  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const setSelectionStart = useEditStore((s) => s.setSelectionStart);
  const setSelectionEnd = useEditStore((s) => s.setSelectionEnd);
  const clearSelectionRange = useEditStore((s) => s.clearSelectionRange);
  const selectedIds = useEditStore((s) => s.selectedIds);
  const toggleSelected = useEditStore((s) => s.toggleSelected);

  const cuts = useMemo(() => manualCuts(ops, silences), [ops, silences]);
  const selectedCutKeys = useMemo(
    () => cuts.map(cutKey).filter((k) => selectedIds.has(k)),
    [cuts, selectedIds],
  );

  const rangeReady =
    selectionStart != null &&
    selectionEnd != null &&
    Math.abs(selectionEnd - selectionStart) >= MIN_CUT_DURATION;

  const busy = editor.isPending;

  const cutRange = () => {
    if (selectionStart == null || selectionEnd == null) return;
    editor.applyOps(ops, addCut(ops, selectionStart, selectionEnd));
    clearSelectionRange();
  };
  const restoreSelected = () => {
    if (selectedCutKeys.length === 0) return;
    editor.applyOps(ops, removeCutsByKey(ops, new Set(selectedCutKeys)));
  };

  return (
    <Card header="Cuts">
      <div className="flex flex-col gap-4">
        <EditLegend />

        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="cut-start" className="flex flex-col gap-1 text-xs text-text-secondary">
            Start
            <TimeInput
              id="cut-start"
              value={selectionStart}
              onCommit={setSelectionStart}
              ariaLabel="Cut start"
            />
          </label>
          <label htmlFor="cut-end" className="flex flex-col gap-1 text-xs text-text-secondary">
            End
            <TimeInput
              id="cut-end"
              value={selectionEnd}
              onCommit={setSelectionEnd}
              ariaLabel="Cut end"
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => wavesurfer && setSelectionStart(wavesurfer.getCurrentTime())}
            disabled={!wavesurfer}
            title="Set start to the playhead (I)"
          >
            Set in
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => wavesurfer && setSelectionEnd(wavesurfer.getCurrentTime())}
            disabled={!wavesurfer}
            title="Set end to the playhead (O)"
          >
            Set out
          </Button>
          <Button size="sm" variant="danger" onClick={cutRange} disabled={!rangeReady || busy}>
            Cut range
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

        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>
            Manual cuts <span className="tabular-nums text-text">{cuts.length}</span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={restoreSelected}
            disabled={selectedCutKeys.length === 0 || busy}
          >
            Restore selected
          </Button>
        </div>

        <CutList
          cuts={cuts}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onSeek={(t) => wavesurfer?.setTime(t)}
        />
      </div>
    </Card>
  );
}

function CutList({
  cuts,
  selectedIds,
  onToggle,
  onSeek,
}: {
  cuts: EditOperation[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSeek: (t: number) => void;
}) {
  if (cuts.length === 0) {
    return (
      <p className="py-2 text-sm text-text-tertiary">
        No manual cuts yet. Mark a range with I / O and press Delete to cut.
      </p>
    );
  }
  return (
    <ul className="max-h-64 divide-y divide-border overflow-y-auto">
      {cuts.map((op, i) => {
        const key = cutKey(op);
        const selected = selectedIds.has(key);
        const end = op.end ?? op.start;
        return (
          <li key={key} className="flex items-center gap-3 py-2 text-sm">
            <input
              type="checkbox"
              className="accent-accent h-4 w-4 cursor-pointer"
              checked={selected}
              onChange={() => onToggle(key)}
              aria-label={`Select cut ${i + 1}`}
            />
            <button
              type="button"
              className="flex flex-1 items-center justify-between gap-4 text-left"
              onClick={() => {
                if (!selected) onToggle(key);
                onSeek(op.start);
              }}
            >
              <span className="w-6 tabular-nums text-text-tertiary">{i + 1}</span>
              <span className={cn("flex-1 tabular-nums text-text-secondary")}>
                {formatClock(op.start)} – {formatClock(end)}
              </span>
              <span className="tabular-nums text-text-tertiary">
                {(end - op.start).toFixed(1)}s
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
