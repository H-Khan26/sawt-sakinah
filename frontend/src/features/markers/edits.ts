/**
 * Pure helpers for editing the marker list. Every marker edit (add / move / relabel /
 * retype / delete) is expressed as a transform on the current `Marker[]`; the caller sends
 * the result to `useUpdateMarkers`, and the server replaces the list and re-derives the
 * prayer structure. Nothing here touches server state or the store.
 *
 * New user markers leave `id` blank so the backend derives the canonical `type-time` id;
 * the returned project (patched into the cache) then carries the real id. Existing markers
 * keep their id across moves/relabels so the selection stays stable.
 */
import type { Marker } from "@/types/api";

/** Marker types the editor lets the user assign (also the select order). */
export const EDITABLE_MARKER_TYPES = ["takbir", "tasmi", "tahmid", "tasleem", "custom"] as const;
export type EditableMarkerType = (typeof EDITABLE_MARKER_TYPES)[number];

/** Default display label per known type (Arabic; chips render RTL). */
export const TYPE_LABELS: Record<EditableMarkerType, string> = {
  takbir: "تكبير",
  tasmi: "تسميع",
  tahmid: "تحميد",
  tasleem: "تسليم",
  custom: "Marker",
};

const byTime = (a: Marker, b: Marker): number => a.time - b.time;

/** A fresh user marker at `time` of the given type; the server derives its id. */
export function newUserMarker(time: number, type: EditableMarkerType): Marker {
  return {
    id: "",
    time,
    end: null,
    label: TYPE_LABELS[type],
    type,
    confidence: 1,
    source: "user",
    duration: null,
  };
}

/** Append `marker`, keeping the list ordered by time. */
export function addMarker(markers: Marker[], marker: Marker): Marker[] {
  return [...markers, marker].sort(byTime);
}

/** Patch the marker with `id` (relabel, retype, or move), re-sorting by time. */
export function patchMarker(markers: Marker[], id: string, patch: Partial<Marker>): Marker[] {
  return markers.map((m) => (m.id === id ? { ...m, ...patch } : m)).sort(byTime);
}

/** Remove the marker with `id`. */
export function removeMarker(markers: Marker[], id: string): Marker[] {
  return markers.filter((m) => m.id !== id);
}
