/**
 * What the editor derives from the EDL and the detected silences, shared by every surface that
 * shows it (the Cut and Silence panels, the waveform regions, playback): the merged cut ranges,
 * how much audio they remove, and the silence view (see `silenceView`). Results are cached on
 * the identity of the ops and silence arrays, which change only on an edit or a fresh
 * detection, so any number of readers cost one pass per edit. Callers must not mutate them.
 */
import { type SilenceView, silenceView } from "@/features/silence/active";
import { type Span, spanTotal } from "@/lib/edl";
import type { EditOperation, ProjectView, SilenceSegment } from "@/types/api";
import { mergeCutSpans } from "./cutEdl";

export interface CutModel extends SilenceView {
  /** The merged cut ranges (see `mergeCutSpans`). */
  cutSpans: Span[];
  /** Seconds the cut ranges remove. */
  removedSeconds: number;
}

interface OpsEntry {
  cutSpans: Span[];
  models: WeakMap<SilenceSegment[], CutModel>;
}

const byOps = new WeakMap<EditOperation[], OpsEntry>();

function entryOf(ops: EditOperation[]): OpsEntry {
  let entry = byOps.get(ops);
  if (!entry) {
    entry = { cutSpans: mergeCutSpans(ops), models: new WeakMap() };
    byOps.set(ops, entry);
  }
  return entry;
}

/** The merged cut ranges of `ops`, computed once per ops array. */
export const cutSpansOf = (ops: EditOperation[]): Span[] => entryOf(ops).cutSpans;

/** The cut model of `ops` against the detected `silences`, computed once per pair of arrays. */
export function cutModel(silences: SilenceSegment[], ops: EditOperation[]): CutModel {
  const entry = entryOf(ops);
  let model = entry.models.get(silences);
  if (!model) {
    const { cutSpans } = entry;
    model = { cutSpans, removedSeconds: spanTotal(cutSpans), ...silenceView(silences, cutSpans) };
    entry.models.set(silences, model);
  }
  return model;
}

/** The cut model of the project's live EDL and detected silences. */
export const useCutModel = (project: ProjectView): CutModel =>
  cutModel(project.silences, project.edl.operations);
