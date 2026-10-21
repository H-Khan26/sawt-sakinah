/**
 * Pure helpers over the surah map: passages grouped per surah with the facts the list shows
 * (ayah range, whether the surah was read complete, how long its passages last), the tone each
 * surah takes in the band and tints, the ranges the surah actions use, and the passages the view
 * shows. All times are source seconds.
 *
 * Only accepted passages are acted on (keep only, new recording, export chapters); unsure ones
 * are shown flagged so the user listens first. Keep only and New recording take each accepted
 * passage out to the user's own cuts where the audio they kept runs past it (`actionRanges`).
 * Hiding Al-Fatihah is visual only, so the groups and their ranges never depend on it.
 */
import { mergeCutSpans } from "@/features/cuts/cutEdl";
import { silenceOnly } from "@/features/silence/active";
import { type Span, firstEndingAfter, mergeSpans, subtractSpans } from "@/lib/edl";
import type { EditOperation, SilenceSegment, SurahInfo, SurahPassage } from "@/types/api";

/** Al-Fatihah, recited in every rak'ah; it has its own quiet tone and can be hidden. */
export const FATIHAH = 1;

/** Seconds a reviewed cut may lie past a passage edge and still move it: about an ayah. */
export const REVIEW_REACH = 20;

/** A surah's tone: neighbouring surahs alternate `a` and `b`, Al-Fatihah is `f`. */
export type SurahTone = "a" | "b" | "f";

export interface SurahGroup {
  surah: number;
  /** All its passages, in time order. */
  passages: SurahPassage[];
  /** Its accepted passages: what Keep only and New recording act on (see `actionRanges`). */
  accepted: SurahPassage[];
  /** Lowest and highest ayah heard across its passages. */
  ayahFrom: number;
  ayahTo: number;
  /** Whether its passages together cover every ayah of the surah. */
  complete: boolean;
  /** Seconds its passages last together. */
  length: number;
  tone: SurahTone;
}

/** Whether the ayah runs of `passages` together cover `1..ayas` without a gap. */
function coversSurah(passages: SurahPassage[], ayas: number): boolean {
  const runs = passages.map((p) => [p.ayah_from, p.ayah_to]).sort((a, b) => a[0] - b[0]);
  let next = 1;
  for (const [from, to] of runs) {
    if (from > next) return false;
    next = Math.max(next, to + 1);
  }
  return next > ayas;
}

/**
 * The passages grouped per surah, in mushaf order. `infos` (the `/quran/surahs` table, by
 * number) supplies the ayah counts; without it no surah counts as complete.
 */
export function groupSurahs(
  passages: SurahPassage[],
  infos: ReadonlyMap<number, SurahInfo> | undefined,
): SurahGroup[] {
  const bySurah = new Map<number, SurahPassage[]>();
  for (const p of [...passages].sort((a, b) => a.start - b.start)) {
    const list = bySurah.get(p.surah);
    if (list) list.push(p);
    else bySurah.set(p.surah, [p]);
  }
  let neighbour = 0;
  return [...bySurah.entries()]
    .sort(([a], [b]) => a - b)
    .map(([surah, list]): SurahGroup => {
      const ayas = infos?.get(surah)?.ayas;
      const tone: SurahTone = surah === FATIHAH ? "f" : neighbour++ % 2 === 0 ? "a" : "b";
      return {
        surah,
        passages: list,
        accepted: list.filter((p) => p.level === "accept"),
        ayahFrom: Math.min(...list.map((p) => p.ayah_from)),
        ayahTo: Math.max(...list.map((p) => p.ayah_to)),
        complete: ayas !== undefined && coversSurah(list, ayas),
        length: list.reduce((sum, p) => sum + (p.end - p.start), 0),
        tone,
      };
    });
}

/** The source-time ranges of a surah's accepted passages. */
export const acceptedRanges = (group: SurahGroup): Span[] =>
  group.accepted.map((p): Span => [p.start, p.end]);

/**
 * The ranges Keep only and New recording use for a surah: its accepted passages, each edge moved
 * out to the user's own cut where the audio they kept runs past it.
 *
 * Only review cuts bound the kept audio: a merged cut range lying within the detected `silences`
 * is silence removal (the rule `silenceView` uses) and is passed over, so an edge padded into a
 * removed pause still reaches the review cut beyond it. Where the stretch between review cuts
 * holding a passage's start begins earlier, at a review cut no more than `REVIEW_REACH` before it
 * and not inside another of the map's `passages`, the start moves there; the end mirrors this.
 * The file's start and end don't count. Elsewhere an edge stays where matching put it: an edge
 * the user tightened is cut inside the range anyway, and without review cuts the ranges are the
 * accepted passages unchanged.
 */
export function actionRanges(
  group: SurahGroup,
  passages: SurahPassage[],
  ops: EditOperation[],
  duration: number,
  silences: SilenceSegment[],
): Span[] {
  const cuts = mergeCutSpans(ops);
  const pure = silenceOnly(cuts, mergeSpans(silences.map((s): Span => [s.start, s.end])));
  const review = cuts.filter((_, i) => !pure[i]);
  if (review.length === 0) return acceptedRanges(group);
  const kept = subtractSpans([[0, duration]], review);
  return group.accepted.map((p): Span => {
    const others = passages.filter((q) => q.start !== p.start || q.end !== p.end);
    let [a, b] = [p.start, p.end];
    const region = kept[firstEndingAfter(kept, a)];
    if (region && region[0] <= a) {
      const floor = Math.max(0, ...others.filter((q) => q.start < p.start).map((q) => q.end));
      if (region[0] > 0 && a - region[0] <= REVIEW_REACH && region[0] >= floor) a = region[0];
    }
    const tail = kept[firstEndingAfter(kept, b)];
    if (tail && tail[0] <= b) {
      const ceil = Math.min(duration, ...others.filter((q) => q.end > p.end).map((q) => q.start));
      if (tail[1] < duration && tail[1] - b <= REVIEW_REACH && tail[1] <= ceil) b = tail[1];
    }
    return [a, b];
  });
}

/** The passages the view shows, in time order: all of them, or all but Al-Fatihah's. */
export const visiblePassages = (passages: SurahPassage[], showFatihah: boolean): SurahPassage[] =>
  showFatihah ? passages : passages.filter((p) => p.surah !== FATIHAH);

/** A surah's display name (its transliteration), with a fallback until the table loads. */
export const surahName = (surah: number, infos: ReadonlyMap<number, SurahInfo> | undefined) =>
  infos?.get(surah)?.tname ?? `Surah ${surah}`;

/** An ayah range, `1–24`, or a single ayah. */
export const ayahRange = (from: number, to: number): string =>
  from === to ? String(from) : `${from}–${to}`;
