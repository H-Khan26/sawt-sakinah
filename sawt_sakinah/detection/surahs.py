"""Surah recognition: match a transcript against the Quran text and return passages.

A pure function from transcript words (``transcribe.Word``, source time) to
``SurahPassage``s: the surah, the ayah range and the start/end of every continuous
passage of recitation it can place in the mushaf. It reads no audio and writes nothing,
and the same input always gives the same result, so it can be re-run on a saved
transcript (``audio/transcript.json``) after a threshold change. Thresholds come from the
``surahs:`` config section. See docs/audio/03-surah-recognition.md.

Matching, step by step:

1. **Normalise.** Transcript and Quran both go through ``_arabic.arabic_words`` (tashkeel
   and tatweel stripped, alef/hamza forms folded, ى -> ي, ة -> ه, marks and punctuation
   dropped). The Quran side is built once by ``quran.py``, without the basmala the text
   puts at the head of each surah.
2. **Anchor.** Every three-word sequence of the transcript is looked up in the Quran's
   three-word index; each exact hit is a candidate placement (a seed). A sequence that
   occurs more than ``anchor_max_hits`` times seeds nothing (the walk from a neighbouring,
   rarer sequence covers it).
3. **Follow.** From a seed the matcher walks forward through transcript and mushaf word
   by word, and backward from the word before the seed, within the seed's surah. A word
   matches when RapidFuzz's ratio clears ``word_match``; a transcript word may also match
   two Quran words written together, or two transcript words one Quran word. At a
   mismatch the walk tries stepping over up to ``max_skip`` transcript words (extra
   speech, a misheard word) and/or Quran words (words the model missed), cheapest first,
   and continues only where the next two words match again. Otherwise the walk ends at
   its last match: speech stopped matching (a takbir, Amin, the adhkar) or the surah ended.
   A walk never crosses a pause longer than ``max_pause`` between transcript words, so
   the rak'ahs of a surah read across a prayer become separate passages.
4. **Resolve repeats.** A seed with several placements (a refrain, a phrase shared
   between surahs) walks each one. Among the walks within 80 % of the longest, one that
   continues the last accepted passage of its surah wins, then the longest, then the
   earliest in the mushaf.
5. **Score.** A walk counts its matched transcript words and its match ratio (matched over
   all transcript words it spans). Its margin is how far it beats the best walk placed in
   a different surah over the same stretch of transcript: ``1 - other / matched`` (1 when
   no other surah matches there at all).
6. **Classify.** ``accept`` needs ``accept_min_words``, ``accept_min_ratio`` and
   ``accept_min_margin``; ``unsure`` needs ``unsure_min_words`` and ``unsure_min_ratio``;
   anything below is rejected and left unlabelled. A short surah heard whole, from its
   first word to its last, needs only ``unsure_min_words`` to be accepted (Al-Kawthar is
   ten words); the ratio and margin bars still apply. A walk that picks up where the
   last accepted passage of the same surah stopped (its first ayah within one of that
   passage's last) is promoted one level, if it has at least ``promote_min_words``
   matched words at the unsure ratio. A walk with more than ``context_max_words`` other
   transcript words in the ``context_window`` seconds before it (or before a basmala
   recited right before it, which isn't counted) is Quran quoted inside
   other speech -- a du'a such as the end of Al-Baqarah -- and is rejected unless it
   continues an accepted passage: recitation in salah follows a takbir and a pause, not
   a stream of words. Accepted and unsure walks become passages and the matcher
   continues after them; after a rejected seed it moves on one word.
7. **Emit passages.** Consecutive passages of one surah that follow on in the mushaf
   (the next starts at most one ayah past the ayah after the last one's end) with no
   pause longer than ``max_pause`` between them merge into one, at the higher of their
   levels: a walk broken where the model missed a few words. A passage starts at its
   first matched ayah word; a basmala recited before it is left outside it, like the
   takbir and Amin. Each edge then snaps to the edge of the speech-map span it falls in
   and pads outward by ``edge_pad`` into the pause, never past the neighbouring span, so
   a cut never clips a word; edges are generous by design. Neighbouring passages never
   overlap.

Cost: about 77,800 Quran words are indexed once (a fraction of a second); a walk costs a
few fuzzy comparisons per word, and the transcript of an hour of recitation (a few
thousand words) is matched in well under a second.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

from ..config import CONFIG
from ..models import SurahPassage
from . import quran
from ._spans import Span
from .transcribe import Word

# Walks within this share of the longest at a seed are considered equally good placements.
_NEAR_BEST = 0.8


@dataclass(frozen=True)
class _Params:
    word_match: float
    accept_min_words: int
    accept_min_ratio: float
    accept_min_margin: float
    unsure_min_words: int
    unsure_min_ratio: float
    promote_min_words: int
    max_skip: int
    max_pause: float
    anchor_max_hits: int
    context_window: float
    context_max_words: int
    edge_pad: float


@dataclass(frozen=True)
class _Walk:
    """A placement of transcript tokens ``t0..t1`` onto Quran words ``q0..q1`` (inclusive)."""

    surah: int
    t0: int
    t1: int
    q0: int
    q1: int
    matched: int
    cells: frozenset[tuple[int, int]]

    @property
    def ratio(self) -> float:
        return self.matched / (self.t1 - self.t0 + 1)


@dataclass
class _Found:
    """A classified walk on its way to becoming a passage."""

    walk: _Walk
    level: str
    ayah_from: int
    ayah_to: int
    start: float  # first word onset
    end: float  # last word offset


class _Matcher:
    def __init__(
        self,
        tokens: list[str],
        times: list[tuple[float, float]],
        q: quran.QuranIndex,
        p: _Params,
    ) -> None:
        from rapidfuzz import fuzz

        self.T = tokens
        # Index one past the last token of each token's pause-free run: walks stay inside.
        self.run_end = [len(tokens)] * len(tokens)
        for k in range(len(tokens) - 2, -1, -1):
            gap = times[k + 1][0] - times[k][1]
            self.run_end[k] = k + 1 if gap > p.max_pause else self.run_end[k + 1]
        self.run_start = [0] * len(tokens)
        for k in range(1, len(tokens)):
            gap = times[k][0] - times[k - 1][1]
            self.run_start[k] = k if gap > p.max_pause else self.run_start[k - 1]
        self.q = q
        self.Q = q.words
        self.p = p
        self._ratio = fuzz.ratio
        self._jumps = sorted(
            ((dt, dq) for dt in range(p.max_skip + 1) for dq in range(p.max_skip + 1) if dt or dq),
            key=lambda j: (j[0] + j[1], abs(j[0] - j[1]), j),
        )

    # -- word comparison -------------------------------------------------------------

    def similar(self, a: str, b: str) -> bool:
        """Whether ``a`` and ``b`` match: equal, or RapidFuzz ratio at least ``word_match``."""
        return a == b or self._ratio(a, b, score_cutoff=self.p.word_match) > 0

    def _match(
        self, ti: int, qi: int, d: int, t_lo: int, t_hi: int, q_lo: int, q_hi: int
    ) -> Optional[tuple[int, int]]:
        """Words consumed ``(transcript, quran)`` by a match at ``(ti, qi)`` walking in
        direction ``d``, or ``None``. Bounds are inclusive-exclusive."""
        if not (t_lo <= ti < t_hi and q_lo <= qi < q_hi):
            return None
        t, w = self.T[ti], self.Q[qi]
        if self.similar(t, w):
            return 1, 1
        q2, t2 = qi + d, ti + d
        if q_lo <= q2 < q_hi:
            pair = w + self.Q[q2] if d > 0 else self.Q[q2] + w
            if self.similar(t, pair):
                return 1, 2
        if t_lo <= t2 < t_hi:
            pair = t + self.T[t2] if d > 0 else self.T[t2] + t
            if self.similar(pair, w):
                return 2, 1
        return None

    # -- walking ---------------------------------------------------------------------

    def _walk_dir(
        self, ti: int, qi: int, d: int, t_lo: int, t_hi: int, q_lo: int, q_hi: int
    ) -> tuple[int, Optional[int], Optional[int], list[tuple[int, int]]]:
        """Follow the mushaf from ``(ti, qi)`` in direction ``d``.

        Returns ``(matched, last_t, last_q, cells)``: matched transcript words, the
        outermost matched transcript and Quran indexes (``None`` when nothing matched),
        and the cells where each match began.
        """
        matched = 0
        last_t = last_q = None
        cells: list[tuple[int, int]] = []
        while True:
            m = self._match(ti, qi, d, t_lo, t_hi, q_lo, q_hi)
            if m is not None:
                dt, dq = m
                matched += dt
                cells.append((ti, qi))
                last_t, last_q = ti + d * (dt - 1), qi + d * (dq - 1)
                ti, qi = ti + d * dt, qi + d * dq
                continue
            for jt, jq in self._jumps:
                nt, nq = ti + d * jt, qi + d * jq
                m1 = self._match(nt, nq, d, t_lo, t_hi, q_lo, q_hi)
                if m1 is None:
                    continue
                at, aq = nt + d * m1[0], nq + d * m1[1]
                # Continue only where the following words agree too, unless the landing
                # word is the last of the surah or of the transcript run (nothing after it
                # to confirm with).
                if (
                    not (q_lo <= aq < q_hi)
                    or not (t_lo <= at < t_hi)
                    or self._match(at, aq, d, t_lo, t_hi, q_lo, q_hi)
                ):
                    ti, qi = nt, nq
                    break
            else:
                return matched, last_t, last_q, cells

    def walk(self, ti: int, qi: int, t_lo: int, t_hi: int) -> Optional[_Walk]:
        """Walk both ways from the seed ``(ti, qi)``, within ``[t_lo, t_hi)``, the seed's
        pause-free run of transcript and the seed's surah."""
        t_lo = max(t_lo, self.run_start[ti])
        t_hi = min(t_hi, self.run_end[ti])
        surah = self.q.surah[qi]
        q_lo = self.q.surah_end[surah - 1] if surah > 1 else 0
        q_hi = self.q.surah_end[surah]
        f_m, f_t, f_q, f_cells = self._walk_dir(ti, qi, 1, t_lo, t_hi, q_lo, q_hi)
        if f_t is None:
            return None
        b_m, b_t, b_q, b_cells = self._walk_dir(ti - 1, qi - 1, -1, t_lo, t_hi, q_lo, q_hi)
        return _Walk(
            surah=surah,
            t0=b_t if b_t is not None else ti,
            t1=f_t,
            q0=b_q if b_q is not None else qi,
            q1=f_q,
            matched=f_m + b_m,
            cells=frozenset(f_cells + b_cells),
        )

    def seeds(self, ti: int) -> list[int]:
        if ti + 2 >= len(self.T):
            return []
        hits = self.q.positions((self.T[ti], self.T[ti + 1], self.T[ti + 2]))
        return hits if len(hits) <= self.p.anchor_max_hits else []

    def margin(self, best: _Walk) -> float:
        """``1 - other / matched`` for the best walk in a different surah over the same
        transcript stretch (1.0 when there is none)."""
        other = 0
        seen: set[tuple[int, int]] = set()
        for tj in range(best.t0, best.t1 - 1):
            for qj in self.seeds(tj):
                if self.q.surah[qj] == best.surah or (tj, qj) in seen:
                    continue
                alt = self.walk(tj, qj, best.t0, best.t1 + 1)
                if alt is None:
                    continue
                seen.update(alt.cells)
                other = max(other, alt.matched)
        return max(0.0, 1.0 - other / best.matched)


def _classify(
    p: _Params, w: _Walk, whole: bool, margin: Callable[[], float], continues: bool
) -> int:
    """0 reject, 1 unsure, 2 accept. ``whole``: the walk runs from the first word of its
    surah to the last. ``margin`` is computed only once the accept word and ratio bars
    hold, since it walks every placement in another surah."""
    ratio = w.ratio
    if (
        (w.matched >= p.accept_min_words or (whole and w.matched >= p.unsure_min_words))
        and ratio >= p.accept_min_ratio
        and margin() >= p.accept_min_margin
    ):
        level = 2
    elif w.matched >= p.unsure_min_words and ratio >= p.unsure_min_ratio:
        level = 1
    else:
        level = 0
    if continues and w.matched >= p.promote_min_words and ratio >= p.unsure_min_ratio:
        level = min(2, level + 1)
    return level


def _basmala_before(m: _Matcher, t0: int, t_lo: int) -> Optional[int]:
    """Index of the first word of a basmala recited right before token ``t0`` (within
    ``[t_lo, t0)``), or ``None``. Three to five words are tried, since the model may split
    or join its words. The basmala stays outside the passage; the context check passes
    over it."""
    target = " ".join(quran.BASMALA)
    for k in (4, 3, 5):
        i = t0 - k
        if i >= t_lo and m.similar(" ".join(m.T[i:t0]), target):
            return i
    return None


def _merge_runs(found: list[_Found], q: quran.QuranIndex, max_pause: float) -> list[_Found]:
    """Merge consecutive passages of one surah that follow on in the mushaf (the next
    starts between the last one's final ayah, less one, and the ayah after next) with at
    most ``max_pause`` seconds between them. The merged passage takes the higher level."""
    out: list[_Found] = []
    for f in found:
        prev = out[-1] if out else None
        if (
            prev is not None
            and prev.walk.surah == f.walk.surah
            and prev.ayah_to - 1 <= f.ayah_from <= prev.ayah_to + 2
            and f.start - prev.end <= max_pause
        ):
            a, b = prev.walk, f.walk
            walk = _Walk(
                surah=a.surah,
                t0=a.t0,
                t1=b.t1,
                q0=a.q0,
                q1=max(a.q1, b.q1),
                matched=a.matched + b.matched,
                cells=a.cells | b.cells,
            )
            level = "accept" if "accept" in (prev.level, f.level) else "unsure"
            out[-1] = _Found(
                walk=walk,
                level=level,
                ayah_from=prev.ayah_from,
                ayah_to=q.ayah[walk.q1],
                start=prev.start,
                end=f.end,
            )
        else:
            out.append(f)
    return out


def _snap_edges(
    found: list[_Found], spans: Optional[Sequence[Span]], total: Optional[float], pad: float
) -> list[tuple[float, float]]:
    """Passage edges snapped to speech-span edges and padded into the pauses.

    Each start moves to the start of the speech span it falls in, then ``pad`` earlier,
    but never before the end of the span before it; ends mirror this. Without spans the
    word times are only padded. Edges are clamped to the file, and neighbouring passages
    that would overlap meet halfway between their words.
    """
    hi = total if total is not None and total > 0 else float("inf")
    starts = [s for s, _ in spans] if spans else []
    out: list[tuple[float, float]] = []
    for f in found:
        a, b = f.start, f.end
        if spans:
            k = bisect_right(starts, a) - 1
            if k >= 0 and spans[k][1] >= a:
                floor = spans[k - 1][1] if k >= 1 else 0.0
                a = max(spans[k][0] - pad, floor)
            else:
                floor = spans[k][1] if k >= 0 else 0.0
                a = max(a - pad, floor)
            k = bisect_right(starts, b) - 1
            ceil = spans[k + 1][0] if k + 1 < len(spans) else hi
            if k >= 0 and spans[k][1] >= b:
                b = min(spans[k][1] + pad, ceil)
            else:
                b = min(b + pad, ceil)
        else:
            a, b = a - pad, b + pad
        out.append((max(0.0, min(a, f.start)), min(hi, max(b, f.end))))
    for i in range(len(out) - 1):
        (a, b), (c, d) = out[i], out[i + 1]
        if b > c:
            mid = (found[i].end + found[i + 1].start) / 2.0
            out[i] = (a, min(b, max(mid, found[i].end)))
            out[i + 1] = (max(c, min(mid, found[i + 1].start)), d)
    return out


def match_surahs(
    words: Sequence[Word],
    *,
    speech_spans: Optional[Sequence[Span]] = None,
    total_duration: Optional[float] = None,
    word_match: float = CONFIG.surahs.word_match,
    accept_min_words: int = CONFIG.surahs.accept_min_words,
    accept_min_ratio: float = CONFIG.surahs.accept_min_ratio,
    accept_min_margin: float = CONFIG.surahs.accept_min_margin,
    unsure_min_words: int = CONFIG.surahs.unsure_min_words,
    unsure_min_ratio: float = CONFIG.surahs.unsure_min_ratio,
    promote_min_words: int = CONFIG.surahs.promote_min_words,
    max_skip: int = CONFIG.surahs.max_skip,
    max_pause: float = CONFIG.surahs.max_pause,
    anchor_max_hits: int = CONFIG.surahs.anchor_max_hits,
    context_window: float = CONFIG.surahs.context_window,
    context_max_words: int = CONFIG.surahs.context_max_words,
    edge_pad: float = CONFIG.surahs.edge_pad,
) -> list[SurahPassage]:
    """Find the surah passages recited in a transcript.

    Pure and deterministic: no audio is read or written.

    Args:
        words: Transcript words in source order (``transcribe.transcribe`` output or a
            loaded sidecar). Each word's ``text`` may hold several normalized words.
        speech_spans: Fine speech spans of the recording (``SpeechMap.spans()``), used to
            snap passage edges; ``None`` pads the word times only.
        total_duration: Recording length, to clamp the padded edges.
        word_match .. edge_pad: The ``surahs:`` config knobs (see defaults.yaml).

    Returns:
        Accepted and unsure passages ordered by start time.

    Raises:
        RuntimeError: If ``rapidfuzz`` (the ``transcription`` extra) is not installed.
    """
    try:
        import rapidfuzz  # noqa: F401
    except ImportError as err:  # pragma: no cover - exercised only without the extra
        raise RuntimeError(
            "Surah matching requires the optional 'transcription' extra "
            '(pip install -e ".[transcription]": faster-whisper + rapidfuzz).'
        ) from err

    p = _Params(
        word_match=word_match,
        accept_min_words=accept_min_words,
        accept_min_ratio=accept_min_ratio,
        accept_min_margin=accept_min_margin,
        unsure_min_words=unsure_min_words,
        unsure_min_ratio=unsure_min_ratio,
        promote_min_words=promote_min_words,
        max_skip=max_skip,
        max_pause=max_pause,
        anchor_max_hits=anchor_max_hits,
        context_window=context_window,
        context_max_words=context_max_words,
        edge_pad=edge_pad,
    )
    tokens: list[str] = []
    times: list[tuple[float, float]] = []
    for w in words:
        for text in w.text.split():
            tokens.append(text)
            times.append((w.start, w.end))
    if not tokens:
        return []

    q = quran.load()
    m = _Matcher(tokens, times, q, p)
    found: list[_Found] = []
    last_accepted: dict[int, _Found] = {}  # by surah
    t_lo = 0  # transcript tokens before this belong to an earlier passage
    used = [False] * len(tokens)  # tokens inside a passage
    i = 0
    while i < len(tokens):
        walks = [w for qi in m.seeds(i) if (w := m.walk(i, qi, t_lo, len(tokens))) is not None]
        if not walks:
            i += 1
            continue

        def continues(w: _Walk) -> bool:
            prev = last_accepted.get(w.surah)
            return prev is not None and prev.ayah_to - 1 <= q.ayah[w.q0] <= prev.ayah_to + 1

        longest = max(w.matched for w in walks)
        best = max(
            (w for w in walks if w.matched >= _NEAR_BEST * longest),
            key=lambda w: (continues(w), w.matched, -w.q0),
        )
        level = 0
        if best.matched >= min(p.promote_min_words, p.unsure_min_words):
            first = q.surah_end[best.surah - 1] if best.surah > 1 else 0
            whole = best.q0 == first and best.q1 == q.surah_end[best.surah] - 1
            level = _classify(p, best, whole, lambda: m.margin(best), continues(best))
        if level and not continues(best):
            basmala = _basmala_before(m, best.t0, t_lo)
            lead = basmala if basmala is not None else best.t0
            since = times[lead][0] - p.context_window
            other = 0
            for k in range(lead - 1, -1, -1):
                if times[k][0] < since:
                    break
                other += not used[k]
            if other > p.context_max_words:
                level = 0
        if level == 0:
            i += 1
            continue
        for k in range(best.t0, best.t1 + 1):
            used[k] = True
        f = _Found(
            walk=best,
            level="accept" if level == 2 else "unsure",
            ayah_from=q.ayah[best.q0],
            ayah_to=q.ayah[best.q1],
            start=times[best.t0][0],
            end=times[best.t1][1],
        )
        found.append(f)
        if level == 2:
            last_accepted[best.surah] = f
        t_lo = i = best.t1 + 1

    found = _merge_runs(found, q, p.max_pause)
    edges = _snap_edges(found, speech_spans, total_duration, p.edge_pad)
    return [
        SurahPassage(
            surah=f.walk.surah,
            ayah_from=f.ayah_from,
            ayah_to=f.ayah_to,
            start=round(a, 3),
            end=round(b, 3),
            confidence=round(f.walk.ratio, 3),
            level=f.level,
        )
        for f, (a, b) in zip(found, edges)
    ]


__all__ = ["match_surahs"]
