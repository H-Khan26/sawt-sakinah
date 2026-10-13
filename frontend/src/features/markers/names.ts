/** Display names for marker phrase types and prayer positions, in transliteration. */
import type { Marker, PrayerPosition } from "@/types/api";

const PHRASE_NAMES: Record<string, string> = {
  takbir: "Takbīr",
  tasmi: "Tasmiʿ",
  tahmid: "Tahmīd",
  tasleem: "Taslīm",
};

/** A phrase type's name (`Takbīr`, …), for the type pickers; `custom` reads `Custom`. */
export const phraseTypeName = (type: string): string =>
  PHRASE_NAMES[type] ?? (type === "custom" ? "Custom" : type);

/** A marker's phrase name (`Takbīr`, …); a custom marker reads as its own label. */
export const phraseName = (marker: Marker): string => PHRASE_NAMES[marker.type] ?? marker.label;

const POSITION_NAMES: Record<string, string> = {
  qiyam: "Qiyam",
  ruku: "Ruku'",
  itidal: "I'tidal",
  sujood: "Sujood",
  julus: "Julus",
  tasleem: "Tasleem",
};

/** A prayer position's display name (`Sujood`, …); unknown names pass through. */
export const positionName = (name: string): string => POSITION_NAMES[name] ?? name;

/** Two times within this many seconds are the same instant (a position derived from a marker). */
const SAME_TIME = 0.05;

/**
 * The marginal note for a marker: its phrase name, plus the position that starts at its time,
 * e.g. `Takbīr · sujood`.
 */
export function markerNote(marker: Marker, structure: PrayerPosition[]): string {
  const phrase = phraseName(marker);
  const position = structure.find((p) => Math.abs(p.start - marker.time) < SAME_TIME);
  // A tasleem opens the tasleem position; naming it twice adds nothing.
  return position && position.name !== marker.type
    ? `${phrase} · ${positionName(position.name).toLowerCase()}`
    : phrase;
}
