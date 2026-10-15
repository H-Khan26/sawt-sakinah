/**
 * Stable identity for a detected silence segment. The backend segments carry no id of their
 * own, so `start:end` (source seconds) keys them for selection and for the waveform regions.
 *
 * Region *drawing* lives in `features/cuts/regions.ts`, which reconciles silence overlays,
 * cut ranges, and the pending selection onto one shared Regions plugin.
 */
import type { SilenceSegment } from "@/types/api";

/** Stable identity for a silence segment (`start:end`). */
export const silenceKey = (seg: SilenceSegment): string => `${seg.start}:${seg.end}`;
