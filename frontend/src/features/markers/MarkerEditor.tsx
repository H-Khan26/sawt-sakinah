/**
 * Marker edit affordances: add a marker at the playhead, and relabel / retype / move /
 * delete the selected marker. Every action computes the next `Marker[]` (pure helpers in
 * edits.ts) and persists it via `useUpdateMarkers`; the server re-derives the prayer
 * structure and returns both, so the outline updates automatically. Marker times are never
 * remapped here — a marker is placed at the raw playhead on the original source timeline.
 */
import { useUpdateMarkers } from "@/api/hooks";
import { Button, Input } from "@/components/ui";
import { formatClock } from "@/lib/time";
import { useMarkerStore } from "@/stores/markerStore";
import { usePlaybackStore } from "@/stores/playbackStore";
import type { ProjectView } from "@/types/api";
import { useEffect, useState } from "react";
import {
  EDITABLE_MARKER_TYPES,
  type EditableMarkerType,
  addMarker,
  newUserMarker,
  patchMarker,
  removeMarker,
} from "./edits";

/** Readable dropdown labels for the marker types. */
const TYPE_DISPLAY: Record<string, string> = {
  takbir: "Takbir",
  tasmi: "Tasmi'",
  tahmid: "Tahmid",
  tasleem: "Tasleem",
  custom: "Custom",
};
const typeDisplay = (t: string): string => TYPE_DISPLAY[t] ?? t;

const SELECT_CLASS =
  "h-8 rounded border border-border bg-background px-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50";

export function MarkerEditor({ project }: { project: ProjectView }) {
  const markers = project.markers;
  const update = useUpdateMarkers(project.id);
  const busy = update.isPending;

  const selectedId = useMarkerStore((s) => s.selectedMarkerId);
  const selectMarker = useMarkerStore((s) => s.selectMarker);
  const selected = markers.find((m) => m.id === selectedId) ?? null;

  const [newType, setNewType] = useState<EditableMarkerType>("takbir");
  const [labelDraft, setLabelDraft] = useState("");

  // Seed the label draft when the selected marker changes (keyed on id, not label, so a
  // server refetch doesn't stomp an in-progress edit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional id-only key
  useEffect(() => {
    setLabelDraft(selected?.label ?? "");
  }, [selected?.id]);

  const playhead = (): number => usePlaybackStore.getState().currentTime;

  const addAtPlayhead = () => {
    update.mutate(addMarker(markers, newUserMarker(playhead(), newType)));
  };

  const commitLabel = () => {
    if (!selected) return;
    const next = labelDraft.trim();
    if (!next || next === selected.label) return;
    update.mutate(patchMarker(markers, selected.id, { label: next }));
  };

  const changeType = (type: string) => {
    if (!selected) return;
    update.mutate(patchMarker(markers, selected.id, { type }));
  };

  const moveToPlayhead = () => {
    if (!selected) return;
    update.mutate(patchMarker(markers, selected.id, { time: playhead() }));
  };

  const deleteSelected = () => {
    if (!selected) return;
    update.mutate(removeMarker(markers, selected.id), { onSuccess: () => selectMarker(null) });
  };

  // The selected marker's type may fall outside the editable set (e.g. a custom detector
  // type); surface it as a leading option so the select stays in sync.
  const typeOptions: readonly string[] =
    selected && !EDITABLE_MARKER_TYPES.includes(selected.type as EditableMarkerType)
      ? [selected.type, ...EDITABLE_MARKER_TYPES]
      : EDITABLE_MARKER_TYPES;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          New marker type
          <select
            className={SELECT_CLASS}
            value={newType}
            disabled={busy}
            onChange={(e) => setNewType(e.target.value as EditableMarkerType)}
          >
            {EDITABLE_MARKER_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeDisplay(t)}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" onClick={addAtPlayhead} disabled={busy}>
          Add marker at playhead
        </Button>
      </div>

      {selected ? (
        <div className="flex flex-col gap-3 rounded border border-border p-3">
          <div className="text-sm text-text-secondary">
            Editing marker at{" "}
            <span className="tabular-nums text-text">{formatClock(selected.time)}</span>
          </div>

          <Input
            label="Label"
            value={labelDraft}
            dir="rtl"
            className="font-arabic"
            disabled={busy}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />

          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            Type
            <select
              className={SELECT_CLASS}
              value={selected.type}
              disabled={busy}
              onChange={(e) => changeType(e.target.value)}
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {typeDisplay(t)}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={moveToPlayhead} disabled={busy}>
              Move to playhead
            </Button>
            <Button size="sm" variant="danger" onClick={deleteSelected} disabled={busy}>
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-tertiary">Select a marker on the waveform to edit it.</p>
      )}
    </div>
  );
}
