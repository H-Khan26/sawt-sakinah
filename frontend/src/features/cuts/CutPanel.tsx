/**
 * Manual cut editing: mark a range by playhead (I/O keys) or by typing timestamps, commit it
 * as a non-destructive `cut`, and manage committed cuts (restore = uncut). Shares the EDL and
 * the undo history with the silence tool via `useEdlEditor`; nothing is rendered destructively
 * until export, and the waveform engine skips committed cuts live during playback.
 */
import { Button } from "@/components/ui";
import { FieldLabel } from "@/features/editor/FieldLabel";
import { ExportModal } from "@/features/export/ExportModal";
import { activeSilences } from "@/features/silence/active";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import type { TimeMap } from "@/features/waveform/timeMap";
import { cn } from "@/lib/cn";
import { formatClock, formatClockPrecise, parseClock } from "@/lib/time";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation, ProjectView } from "@/types/api";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SplitModal } from "./SplitModal";
import { MIN_CUT_DURATION, addCut, cutKey, keepOnly, manualCuts, removeCutsByKey } from "./cutEdl";
import { isTypingTarget } from "./useEditHotkeys";
import { useEdlEditor } from "./useEdlEditor";

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
    </p>
  );
}

export function CutPanel({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const ops = project.edl.operations;
  const silences = project.silences;

  const { controller, timeMap, isReady } = useWaveformContext();
  const editor = useEdlEditor(projectId);

  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const setSelectionStart = useEditStore((s) => s.setSelectionStart);
  const setSelectionEnd = useEditStore((s) => s.setSelectionEnd);
  const clearSelectionRange = useEditStore((s) => s.clearSelectionRange);
  const selectedIds = useEditStore((s) => s.selectedIds);
  const toggleSelected = useEditStore((s) => s.toggleSelected);

  const [cutsOpen, setCutsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  const duration = project.audio_source.duration_sec;

  // Manual cuts are all cut ops that aren't a (possibly clipped) silence removal — classify
  // against the active silence set so removing a clipped silence doesn't also list it here.
  const active = useMemo(() => activeSilences(silences, ops), [silences, ops]);
  const cuts = useMemo(() => manualCuts(ops, active), [ops, active]);
  const selectedCutKeys = useMemo(
    () => cuts.map(cutKey).filter((k) => selectedIds.has(k)),
    [cuts, selectedIds],
  );

  const rangeReady =
    selectionStart != null &&
    selectionEnd != null &&
    Math.abs(selectionEnd - selectionStart) >= MIN_CUT_DURATION;

  const busy = editor.isPending;

  // Normalized source-time selection (min/max), or null when no valid range is marked.
  const range =
    rangeReady && selectionStart != null && selectionEnd != null
      ? {
          start: Math.min(selectionStart, selectionEnd),
          end: Math.max(selectionStart, selectionEnd),
        }
      : null;

  const cutRange = () => {
    if (selectionStart == null || selectionEnd == null) return;
    editor.applyOps(ops, addCut(ops, selectionStart, selectionEnd));
    clearSelectionRange();
  };
  const keepOnlyRange = () => {
    if (!range) return;
    editor.applyOps(ops, keepOnly(ops, range.start, range.end, duration));
    clearSelectionRange();
  };
  const restoreSelected = () => {
    if (selectedCutKeys.length === 0) return;
    editor.applyOps(ops, removeCutsByKey(ops, new Set(selectedCutKeys)));
  };

  // Selection-action shortcuts (E export, N new recording, K keep-only), co-located here since the
  // range + modal state live in this component. Read via a ref so the listener subscribes once
  // while acting on fresh state; suppressed while typing or while a selection modal is open.
  const hotkeyRef = useRef({ keepOnlyRange, setExportOpen, setSplitOpen, rangeReady, busy });
  hotkeyRef.current = { keepOnlyRange, setExportOpen, setSplitOpen, rangeReady, busy };
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
        if (h.busy) return;
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
        <Button onClick={cutRange} disabled={!rangeReady || busy} title="Cut the range (Delete)">
          Cut range
        </Button>
        <Button
          variant="secondary"
          onClick={keepOnlyRange}
          disabled={!rangeReady || busy}
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

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-sm text-text-secondary">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            onClick={() => setCutsOpen((v) => !v)}
            aria-expanded={cutsOpen}
          >
            <ChevronRight
              size={16}
              className={cn("transition-transform duration-fast", cutsOpen && "rotate-90")}
              aria-hidden
            />
            Manual cuts <span className="tabular-nums text-text">{cuts.length}</span>
          </button>
          {cutsOpen && (
            <Button
              size="sm"
              variant="secondary"
              onClick={restoreSelected}
              disabled={selectedCutKeys.length === 0 || busy}
            >
              Restore selected
            </Button>
          )}
        </div>

        {cutsOpen && (
          <CutList
            cuts={cuts}
            timeMap={timeMap}
            selectedIds={selectedIds}
            onToggle={toggleSelected}
            onSeek={(t) => controller.setSourceTime(t)}
          />
        )}
      </div>

      {exportOpen && range && (
        <ExportModal project={project} range={range} onClose={() => setExportOpen(false)} />
      )}
      {splitOpen && range && (
        <SplitModal project={project} range={range} onClose={() => setSplitOpen(false)} />
      )}
    </div>
  );
}

function CutList({
  cuts,
  timeMap,
  selectedIds,
  onToggle,
  onSeek,
}: {
  cuts: EditOperation[];
  timeMap: TimeMap;
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
    <ul className="max-h-48 divide-y divide-border overflow-y-auto border-y border-border">
      {cuts.map((op, i) => {
        const key = cutKey(op);
        const selected = selectedIds.has(key);
        const end = op.end ?? op.start;
        return (
          <li key={key} className="flex items-center gap-3 py-1.5 text-sm">
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
              <span className="flex-1 tabular-nums text-text-secondary">
                {formatClock(timeMap.toEdited(op.start))}
              </span>
              <span className="tabular-nums text-text-tertiary">
                −{(end - op.start).toFixed(1)}s removed
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
