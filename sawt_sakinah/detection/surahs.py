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
   puts at the head of each surah. A word timed across ``word_gap`` or more of silence
   (the alignment smeared it over a neighbouring clip) is first trimmed to the side of
   that pause holding more of its speech.
2. **Anchor.** Every three-word sequence of the transcript is looked up in the Quran's
   three-word index; each exact hit is a candidate placement (a seed). A sequence that
   occurs more than ``anchor_max_hits`` times seeds nothing (the walk from a neighbouring,
   rarer sequence covers it), nor does one starting on a wall (below).
3. **Follow.** From a seed the matcher walks forward through transcript and mushaf word
   by word, and backward from the word before the seed, within the seed's surah. A word
   matches when RapidFuzz's ratio clears ``word_match``; a transcript word may also match
   two Quran words written together, or two transcript words one Quran word. At a
   mismatch the walk tries stepping over up to ``max_skip`` transcript words (extra
   speech, a misheard word) and/or Quran words (words the model missed), cheapest first,
   and continues only where the next two words match again; only the surah's own edge is
   taken unconfirmed. Pauses are silence measured on the speech map (the plain time
   between words without one): a walk never crosses more than ``max_pause`` of silence,
   whether between neighbouring words or inside a skip, so the rak'ahs of a surah read
   across a prayer become separate passages. The takbir, tasmi' and tahmid (``_WALLS``)
   are walls a walk never includes or crosses.
4. **Resolve repeats.** A seed with several placements (a refrain, a phrase shared
   between surahs) walks each one. Among the walks within 80 % of the longest, one that
   resumes the last accepted passage of its surah wins, then the longest, then the
   earliest in the mushaf.
5. **Score.** A walk counts its matched transcript words and its match ratio (matched over
   all transcript words it spans). Its margin is how far it beats the best walk placed in
   a different surah over the same stretch of transcript: ``1 - other / matched`` (1 when
   no other surah matches there at all).
6. **Classify.** ``accept`` needs ``accept_min_words``, ``accept_min_ratio`` and
   ``accept_min_margin``; ``unsure`` needs ``unsure_min_words`` and ``unsure_min_ratio``;
   anything below is rejected and left unlabelled. A short surah heard whole, from its
   first word to its last, needs only ``unsure_min_words`` to be accepted (Al-Kawthar is
   ten words); the ratio and margin bars still apply. A walk that resumes the last
   accepted passage of the same surah (``_resumes``: its first Quran word at most
   ``resume_max_words`` past where that passage stopped, or back to the start of the
   ayah before) is promoted one level, if it has at least ``promote_min_words`` matched
   words at the unsure ratio. A walk that doesn't resume one is rejected when more than
   ``context_max_words`` other transcript words run on into it, at most ``context_gap``
   of silence apart and within ``context_window`` seconds (a basmala right before it
   not counted): that is Quran quoted inside other speech -- a du'a such as the end of
   Al-Baqarah -- since recitation in salah follows a takbir and a pause, not a stream of
   words. A walk of another surah than the last passage needs ``surah_min_pause`` of
   silence after that passage, since a surah starts after the Amin, a takbir or a
   basmala; words of the next surah running straight on are its alignment spilling over.
   Accepted and unsure walks become passages and the matcher continues after them; after
   a rejected seed it moves on one word.
7. **Emit passages.** A first or last group of at most ``edge_trim_words`` matched words
   standing ``edge_trim_pause`` of silence apart from the rest of its walk while its ayah
   runs on across that pause is dropped: a takbir or Amin misheard as those words, or
   their times smeared onto one. Consecutive passages of one surah where the next
   resumes the last (``_resumes``) across at most ``merge_max_pause`` of silence merge
   into one, at the higher of their levels: a walk broken where the model missed a few
   words. A passage starts at its first matched ayah word; a basmala recited before it is
   left outside it, like the takbir and Amin. Each edge then snaps to the edge of the
   speech-map span it falls in (a start in a pause to the next span's start, an end in a
   pause to the previous span's end) and pads outward by ``edge_pad`` into the pause,
   never past the neighbouring span, so a cut lands in a pause; edges are generous by
   design. Neighbouring passages that would overlap meet halfway between their words.

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
from ._arabic import arabic_words
from ._spans import Span, SpeechIndex
from .transcribe import Word

# Walks within this share of the longest at a seed are considered equally good placements.
_NEAR_BEST = 0.8

# Phrases of the prayer itself, as the matcher sees them: the takbir, the tasmi' and the
# tahmid. A walk never includes or crosses them, so a takbir after a surah's last word
# can't be taken for the next ayah's ``الله``.
_WALLS = tuple(
    tuple(arabic_words(text))
    for text in ("الله اكبر", "سمع الله لمن حمده", "ربنا لك الحمد", "ربنا ولك الحمد")
)


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
    context_gap: float
    resume_max_words: int
    merge_max_pause: float
    surah_min_pause: float
    word_gap: float
    edge_trim_pause: float
    edge_trim_words: int
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
    # Each match as ``(t, q, dt, dq)``: its first transcript token and Quran word, and
    # how many of each it consumed.
    cells: frozenset[tuple[int, int, int, int]]

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


def _word_times(
    words: Sequence[Word], speech: SpeechIndex, word_gap: float
) -> list[tuple[float, float]]:
    """Each word's ``(start, end)``, trimmed to the side of any pause of at least
    ``word_gap`` seconds inside it that holds more of its speech. A word timed across a
    long silence is the alignment smearing it over the neighbouring clip, not a long word:
    a passage's first word then starts in the Amin or takbir before it, and its last word
    ends in the takbir after it."""
    out: list[tuple[float, float]] = []
    for w in words:
        a, b = w.start, w.end
        for _ in range(3):
            if not speech.spans or speech.silence(a, b) < word_gap:
                break
            lo = max(0, bisect_right(speech.starts, a) - 1)
            hi = bisect_right(speech.starts, b)
            pieces = [(max(a, s), min(b, e)) for s, e in speech.spans[lo:hi] if e > a]
            if not pieces:
                break
            edges = [a] + [t for s, e in pieces for t in (s, e)] + [b]
            pauses = [
                (edges[i + 1] - edges[i], edges[i], edges[i + 1]) for i in range(0, len(edges), 2)
            ]
            length, lo, hi = max(pauses)
            if length < word_gap:
                break
            left = sum(e - s for s, e in pieces if e <= lo)
            right = sum(e - s for s, e in pieces if s >= hi)
            if left >= right:
                b = lo
            else:
                a = hi
        out.append((a, b))
    return out


class _Matcher:
    def __init__(
        self,
        tokens: list[str],
        times: list[tuple[float, float]],
        q: quran.QuranIndex,
        p: _Params,
        speech: SpeechIndex,
    ) -> None:
        from rapidfuzz import fuzz

        self.T = tokens
        self.times = times
        self.speech = speech
        self.q = q
        self.Q = q.words
        self.p = p
        self._ratio = fuzz.ratio
        self.wall = self._walls()
        # Index one past the last token of each token's run, and the run's first token:
        # walks stay inside. A run ends at a pause longer than ``max_pause`` or at a wall.
        n = len(tokens)
        cut = [
            self.pause(k, k + 1) > p.max_pause or self.wall[k] or self.wall[k + 1]
            for k in range(n - 1)
        ]
        self.run_end = [n] * n
        for k in range(n - 2, -1, -1):
            self.run_end[k] = k + 1 if cut[k] else self.run_end[k + 1]
        self.run_start = [0] * n
        for k in range(1, n):
            self.run_start[k] = k if cut[k - 1] else self.run_start[k - 1]
        self._jumps = sorted(
            ((dt, dq) for dt in range(p.max_skip + 1) for dq in range(p.max_skip + 1) if dt or dq),
            key=lambda j: (j[0] + j[1], abs(j[0] - j[1]), j),
        )

    def _walls(self) -> list[bool]:
        """Whether each token is part of a ``_WALLS`` phrase, each word matched fuzzily."""
        wall = [False] * len(self.T)
        for k in range(len(self.T)):
            for phrase in _WALLS:
                if k + len(phrase) <= len(self.T) and all(
                    self.similar(self.T[k + i], w) for i, w in enumerate(phrase)
                ):
                    wall[k : k + len(phrase)] = [True] * len(phrase)
        return wall

    def pause(self, i: int, j: int) -> float:
        """Silence between tokens ``i`` and ``j`` (either order): the non-speech seconds
        from the earlier one's end to the later one's start."""
        if i > j:
            i, j = j, i
        return self.speech.silence(self.times[i][1], self.times[j][0])

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
    ) -> tuple[int, Optional[int], Optional[int], list[tuple[int, int, int, int]]]:
        """Follow the mushaf from ``(ti, qi)`` in direction ``d``.

        Returns ``(matched, last_t, last_q, cells)``: matched transcript words, the
        outermost matched transcript and Quran indexes (``None`` when nothing matched),
        and the matches as ``_Walk.cells`` entries.
        """
        matched = 0
        last_t = last_q = None
        cells: list[tuple[int, int, int, int]] = []
        while True:
            m = self._match(ti, qi, d, t_lo, t_hi, q_lo, q_hi)
            if m is not None:
                dt, dq = m
                matched += dt
                last_t, last_q = ti + d * (dt - 1), qi + d * (dq - 1)
                cells.append((min(ti, last_t), min(qi, last_q), dt, dq))
                ti, qi = ti + d * dt, qi + d * dq
                continue
            prev = ti - d
            for jt, jq in self._jumps:
                nt, nq = ti + d * jt, qi + d * jq
                # Skipped transcript words hold misheard speech, not a long pause.
                if (
                    jt
                    and 0 <= prev < len(self.T)
                    and 0 <= nt < len(self.T)
                    and self.pause(prev, nt) > self.p.max_pause
                ):
                    continue
                m1 = self._match(nt, nq, d, t_lo, t_hi, q_lo, q_hi)
                if m1 is None:
                    continue
                at, aq = nt + d * m1[0], nq + d * m1[1]
                # Continue only where the following words agree too; only the surah's
                # last word is taken unconfirmed (nothing after it to confirm with). A
                # stray word at the run's edge, a takbir or a scrap of one, would
                # otherwise pull the walk out to it.
                if not (q_lo <= aq < q_hi) or self._match(at, aq, d, t_lo, t_hi, q_lo, q_hi):
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
        if ti + 2 >= len(self.T) or self.wall[ti]:
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
                seen.update((t, q) for t, q, _, _ in alt.cells)
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


def _resumes(q: quran.QuranIndex, prev: _Walk, w: _Walk, max_words: int) -> bool:
    """Whether walk ``w`` picks up where ``prev`` (same surah, earlier) stopped: its first
    Quran word at most ``max_words`` past the word after ``prev``'s last (the model missed
    or garbled a stretch), or anywhere back to the start of the ayah before ``prev``'s
    last (the reciter went back an ayah to resume)."""
    back = prev.q1
    while back > 0 and q.surah[back - 1] == q.surah[back] and q.ayah[back - 1] >= q.ayah[prev.q1] - 1:
        back -= 1
    return back <= w.q0 <= prev.q1 + 1 + max_words


def _trim_edges(m: _Matcher, w: _Walk, q: quran.QuranIndex, p: _Params) -> _Walk:
    """``w`` without a first or last group of at most ``edge_trim_words`` matched tokens
    that stands apart from the rest of the walk by ``edge_trim_pause`` seconds of silence
    while its ayah runs on across that pause. Nobody pauses that long inside an ayah's
    opening or closing words: the group is a takbir or Amin misheard as those words, or
    their times smeared onto it. A group that ends its ayah (a lone ``الم``) stays."""
    if p.edge_trim_words <= 0 or not w.cells:
        return w
    cells = sorted(w.cells)
    t0, t1, q0, q1, matched = w.t0, w.t1, w.q0, w.q1, w.matched

    def same_ayah(i: int, j: int) -> bool:
        return 0 <= i < len(q.ayah) and 0 <= j < len(q.ayah) and (q.ayah[i], q.surah[i]) == (q.ayah[j], q.surah[j])

    k = t0
    while k < t1 and m.pause(k, k + 1) < p.edge_trim_pause:
        k += 1
    if k < t1 and k - t0 + 1 <= p.edge_trim_words:
        # The group's last Quran word, and the first match after the pause.
        before = [c for c in cells if c[0] <= k]
        rest = [c for c in cells if c[0] > k]
        last_q = before[-1][1] + before[-1][3] - 1
        if rest and same_ayah(last_q, last_q + 1):
            matched -= sum(c[2] for c in before)
            cells = rest
            t0, q0 = rest[0][0], rest[0][1]
    k = t1
    while k > t0 and m.pause(k - 1, k) < p.edge_trim_pause:
        k -= 1
    if k > t0 and t1 - k + 1 <= p.edge_trim_words:
        # The group's first Quran word, and the last match before the pause.
        after = [c for c in cells if c[0] + c[2] - 1 >= k]
        rest = [c for c in cells if c[0] + c[2] - 1 < k]
        first_q = after[0][1]
        if rest and same_ayah(first_q - 1, first_q):
            matched -= sum(c[2] for c in after)
            cells = rest
            t1, q1 = rest[-1][0] + rest[-1][2] - 1, rest[-1][1] + rest[-1][3] - 1
    if (t0, t1) == (w.t0, w.t1):
        return w
    return _Walk(
        surah=w.surah,
        t0=t0,
        t1=t1,
        q0=q0,
        q1=q1,
        matched=max(1, matched),
        cells=frozenset(cells),
    )


def _merge_runs(
    found: list[_Found], q: quran.QuranIndex, max_words: int, max_pause: float, speech: SpeechIndex
) -> list[_Found]:
    """Merge consecutive passages of one surah where the next resumes the last
    (``_resumes``) with at most ``max_pause`` seconds of silence between them. The merged
    passage takes the higher level."""
    out: list[_Found] = []
    for f in found:
        prev = out[-1] if out else None
        if (
            prev is not None
            and prev.walk.surah == f.walk.surah
            and _resumes(q, prev.walk, f.walk, max_words)
            and speech.silence(prev.end, f.start) <= max_pause
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

    Each start moves to the start of the speech span it falls in, or of the next span when
    it falls in a pause (speech doesn't start in silence), then ``pad`` earlier, but never
    before the end of the span before it; ends mirror this. Without spans the word times
    are only padded. Edges are clamped to the file, and neighbouring passages that would
    overlap meet halfway between their words. Edges that would cross (every word of the
    passage timed into one pause) fall back to the padded word times.
    """
    hi = total if total is not None and total > 0 else float("inf")
    starts = [s for s, _ in spans] if spans else []
    out: list[tuple[float, float]] = []
    for f in found:
        a, b = f.start, f.end
        if spans:
            k = bisect_right(starts, a) - 1
            if k >= 0 and spans[k][1] >= a:
                edge, floor = spans[k][0], (spans[k - 1][1] if k >= 1 else 0.0)
            else:
                edge = spans[k + 1][0] if k + 1 < len(spans) else a
                floor = spans[k][1] if k >= 0 else 0.0
            a = max(edge - pad, floor)
            k = bisect_right(starts, b) - 1
            ceil = spans[k + 1][0] if k + 1 < len(spans) else hi
            b = min((spans[k][1] if k >= 0 else b) + pad, ceil)
        else:
            a, b = a - pad, b + pad
        if a > b:
            a, b = f.start - pad, f.end + pad
        out.append((max(0.0, a), min(hi, b)))
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
    context_gap: float = CONFIG.surahs.context_gap,
    resume_max_words: int = CONFIG.surahs.resume_max_words,
    merge_max_pause: float = CONFIG.surahs.merge_max_pause,
    surah_min_pause: float = CONFIG.surahs.surah_min_pause,
    word_gap: float = CONFIG.surahs.word_gap,
    edge_trim_pause: float = CONFIG.surahs.edge_trim_pause,
    edge_trim_words: int = CONFIG.surahs.edge_trim_words,
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
        context_gap=context_gap,
        resume_max_words=resume_max_words,
        merge_max_pause=merge_max_pause,
        surah_min_pause=surah_min_pause,
        word_gap=word_gap,
        edge_trim_pause=edge_trim_pause,
        edge_trim_words=edge_trim_words,
        edge_pad=edge_pad,
    )
    speech = SpeechIndex(speech_spans)
    tokens: list[str] = []
    times: list[tuple[float, float]] = []
    for w, span in zip(words, _word_times(words, speech, word_gap)):
        for text in w.text.split():
            tokens.append(text)
            times.append(span)
    if not tokens:
        return []

    q = quran.load()
    m = _Matcher(tokens, times, q, p, speech)
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
            return prev is not None and _resumes(q, prev.walk, w, p.resume_max_words)

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
        if level:
            best = _trim_edges(m, best, q, p)
        if level and not continues(best):
            basmala = _basmala_before(m, best.t0, t_lo)
            lead = basmala if basmala is not None else best.t0
            since = times[lead][0] - p.context_window
            other = 0
            for k in range(lead - 1, -1, -1):
                if times[k][0] < since or m.pause(k, k + 1) > p.context_gap:
                    break
                other += not used[k]
            if other > p.context_max_words:
                level = 0
        # A surah starts after a pause (the Amin, a takbir, a basmala): words of another
        # surah running straight on from the last passage are its alignment spilling
        # over the end of that passage.
        if (
            level
            and found
            and found[-1].walk.surah != best.surah
            and speech.silence(found[-1].end, times[best.t0][0]) < p.surah_min_pause
        ):
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

    found = _merge_runs(found, q, p.resume_max_words, p.merge_max_pause, speech)
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
