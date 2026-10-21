"""Tuning harness for surah cut placement, scored against hand-reviewed recordings.

Each case directory (``~/sawt-tuning/cases/<slug>/`` by default) holds a reviewed
project: ``project.json`` (its EDL cuts are the review: everything that is not recitation
is cut), ``transcript.json``, ``source.speech.npz`` and ``source.work.wav``. The kept
regions, ``[0, duration]`` minus the merged cuts, are the ground truth: each is one
stretch of recitation with about a second of air at each edge. A directory whose name
starts with ``_`` is skipped unless named with ``--case``.

Commands:
  truth       print each case's kept regions and their speech edges
  score       match each case's transcript and score the passages against the truth
  sweep       score a grid of knob settings (full product, or ``--coordinate`` descent)
  edges       show the words, spans and edges around a time point
  transcribe  write a transcript variant (``transcripts/NAME.json`` + ``NAME.meta.json``)

Knobs are set with ``--set section.key=value``: ``surahs.*`` go to ``match_surahs``,
``segmentation.*`` to ``SpeechMap.spans`` (the matcher's spans only: scoring always measures
speech with the default spans, so a sweep can't win by seeing less speech) and
``transcription.*`` to ``transcribe``. Defaults come from the base defaults file
(``config.config_path()``), never from a per-user config.yaml. Only the cases directory
is read or written; ``transcribe`` also reads the installed model.

Usage:
  .venv/Scripts/python scripts/tune_surahs.py score --worst 12
  .venv/Scripts/python scripts/tune_surahs.py sweep --grid surahs.edge_pad=0.5,1.0 --top 8
  .venv/Scripts/python scripts/tune_surahs.py edges --case anbiya-luqman --at 404
  .venv/Scripts/python scripts/tune_surahs.py transcribe --variant beam1 \\
      --set transcription.beam_size=1 --case anbiya-luqman
"""

from __future__ import annotations

import argparse
import inspect
import itertools
import json
import math
import sys
import time
from bisect import bisect_left, bisect_right
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

from functools import lru_cache

from pydantic import ValidationError

from sawt_sakinah import runtime
from sawt_sakinah.config import Config, config_path, load_config
from sawt_sakinah.detection import quran, whisper_models
from sawt_sakinah.detection._spans import Span, invert_spans, merge_within_gap
from sawt_sakinah.detection._spans import SpeechIndex as _SpeechIndex
from sawt_sakinah.detection.segmentation import SpeechMap
from sawt_sakinah.detection.surahs import match_surahs
from sawt_sakinah.detection.transcribe import Word, load_transcript, save_transcript, transcribe
from sawt_sakinah.models import SurahPassage
from sawt_sakinah.models.edl import EditOperation, normalize_cuts

DEFAULT_CASES = Path.home() / "sawt-tuning" / "cases"

# Objective weights; the cost is a weighted sum and lower is better.
W_MISSED = 20.0
W_SPURIOUS = 10.0
W_MIXED = 10.0
W_CLIP = 3.0
W_ABSORBED = 3.0
W_LEAKED = 2.0
W_INTERNAL = 1.5
W_TIGHT = 1.0
W_AIR = 0.3
W_AIR_LONG = 0.5

AIR_TARGET = 1.0  # seconds of silence the user keeps at each edge of a recitation
AIR_LONG = 2.5  # more air than this is too much buffer
TIGHT_AIR = 0.25  # less air than this, with no clip, leaves no room for a fade
NOISE = 0.15  # clip, absorbed and leaked speech below this is span-edge noise
AIR_MAX_SPEECH = 0.1  # air is measured only while absorbed and leaked speech stay below this
REPORT_MIN = 0.3  # edge errors at or above this are counted in the summary
ASSIGN_SHARE = 0.5  # a passage belongs to a region it overlaps by this share of either length
AMIN_MAX = 4.5  # an Al-Fatihah region's last span, standing apart and no longer than this, is the Amin
BASMALA = "بسم الله الرحمن الرحيم"
BASMALA_MATCH = 70  # words before an Al-Fatihah this close to the basmala make a leak neutral
# Scoring always measures speech with these spans, whatever segmentation the matcher gets.
SCORE_SEG = {"speech_threshold": 0.5, "min_speech_duration": 0.25, "bridge_gap": 0.2, "speech_pad": 0.03}
AMIN_GAP = 0.2  # ... when at least this much silence separates it from the span before
SLIVER = 1.0  # kept regions shorter than this are flagged
BAR_WIDTH = 64  # characters across a drill-down window

# match_surahs keyword knobs, the surahs: config keys they bind to, plus the surahs:
# bridge gap the matcher's spans are built with (not a match_surahs argument).
SURAH_KNOBS = tuple(
    name
    for name in inspect.signature(match_surahs).parameters
    if name not in ("words", "speech_spans", "total_duration")
) + ("bridge_gap",)
# segmentation: config keys and the SpeechMap.spans arguments they map to.
SEG_ARGS = {
    "speech_threshold": "threshold",
    "min_speech_duration": "min_speech_duration",
    "bridge_gap": "bridge_gap",
    "speech_pad": "speech_pad",
}
# transcription: config keys, all transcribe() keyword arguments.
TRANS_KNOBS = (
    "device",
    "compute_type",
    "language",
    "beam_size",
    "vad_filter",
    "clip_merge_gap",
    "clip_pad",
    "clip_gap",
    "condition_on_previous_text",
    "window_reset",
)
KNOB_KEYS = {"surahs": SURAH_KNOBS, "segmentation": tuple(SEG_ARGS), "transcription": TRANS_KNOBS}
# Bounds (inclusive) for knobs the config schema leaves unbounded.
KNOB_BOUNDS = {
    "segmentation.speech_threshold": (0.0, 1.0),
    "segmentation.min_speech_duration": (0.0, math.inf),
    "segmentation.bridge_gap": (0.0, math.inf),
    "segmentation.speech_pad": (0.0, math.inf),
    "transcription.clip_merge_gap": (0.0, math.inf),
    "transcription.clip_pad": (0.0, math.inf),
}

Knobs = dict[str, dict[str, Any]]


class KnobError(ValueError):
    """An unknown or malformed ``section.key=value`` setting."""


# -- knobs --------------------------------------------------------------------------------


@lru_cache(maxsize=1)
def base_config() -> Config:
    """The base defaults file, without any per-user config.yaml."""
    return load_config(config_path())


def default_knobs() -> Knobs:
    """The knob defaults from the base defaults file, by section."""
    cfg = base_config()
    return {
        "surahs": {k: getattr(cfg.surahs, k) for k in SURAH_KNOBS},
        "segmentation": {k: getattr(cfg.segmentation, k) for k in SEG_ARGS},
        "transcription": {k: getattr(cfg.transcription, k) for k in TRANS_KNOBS},
    }


def parse_value(text: str) -> Any:
    """``text`` as a bool, int, float or (failing those) the string itself."""
    low = text.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    for kind in (int, float):
        try:
            return kind(text)
        except ValueError:
            pass
    return text


def parse_key(name: str, sections: Sequence[str]) -> tuple[str, str]:
    """Split ``section.key`` and check it names a knob of one of ``sections``."""
    section, _, key = name.strip().partition(".")
    if section not in sections:
        raise KnobError(f"unknown knob {name!r}: the section must be one of {', '.join(sections)}")
    if key not in KNOB_KEYS[section]:
        raise KnobError(
            f"unknown knob {name!r}; {section} keys are: {', '.join(KNOB_KEYS[section])}"
        )
    return section, key


def parse_setting(item: str, sections: Sequence[str]) -> tuple[str, str, str]:
    """``section.key=value`` -> ``(section, key, value text)``."""
    name, eq, value = item.partition("=")
    if not eq or not value.strip():
        raise KnobError(f"expected section.key=value, got {item!r}")
    section, key = parse_key(name, sections)
    return section, key, value.strip()


def check_value(section: str, key: str, value: Any) -> Any:
    """``value`` validated against the config schema for ``section.key`` (type and bounds),
    coerced to the knob's type."""
    current = getattr(base_config(), section)
    name = f"{section}.{key}"
    if isinstance(value, bool) != isinstance(getattr(current, key), bool):
        raise KnobError(f"invalid value {value!r} for {name}: wrong type")
    if isinstance(value, float) and not math.isfinite(value):
        raise KnobError(f"invalid value {value!r} for {name}: must be finite")
    try:
        checked = getattr(type(current).model_validate({**current.model_dump(), key: value}), key)
    except ValidationError as err:
        reason = "; ".join(e["msg"] for e in err.errors())
        raise KnobError(f"invalid value {value!r} for {name}: {reason}") from None
    if name in KNOB_BOUNDS:
        lo, hi = KNOB_BOUNDS[name]
        if not lo <= checked <= hi:
            raise KnobError(f"invalid value {value!r} for {name}: must be in [{lo}, {hi}]")
    return checked


def apply_settings(knobs: Knobs, items: Sequence[str] | None, sections: Sequence[str]) -> Knobs:
    """A copy of ``knobs`` with ``--set`` items applied."""
    out = {s: dict(v) for s, v in knobs.items()}
    for item in items or []:
        section, key, value = parse_setting(item, sections)
        out[section][key] = check_value(section, key, parse_value(value))
    return out


def parse_grid(items: Sequence[str]) -> list[tuple[str, str, list[Any]]]:
    """``--grid section.key=v1,v2`` items -> ``[(section, key, values)]``."""
    grid = []
    seen = set()
    for item in items:
        section, key, text = parse_setting(item, ("surahs", "segmentation"))
        if (section, key) in seen:
            raise KnobError(f"{section}.{key} is given twice in --grid")
        seen.add((section, key))
        values = [
            check_value(section, key, parse_value(v)) for v in text.split(",") if v.strip()
        ]
        if not values:
            raise KnobError(f"no values for {section}.{key}")
        grid.append((section, key, values))
    return grid


def knob_diff(knobs: Knobs, base: Knobs) -> dict[str, Any]:
    """``section.key: value`` for every knob that differs from ``base``."""
    return {
        f"{s}.{k}": v for s in knobs for k, v in knobs[s].items() if base[s].get(k) != v
    }


# -- span arithmetic ----------------------------------------------------------------------


def overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


class SpeechIndex(_SpeechIndex):
    """The matcher's speech index, with the lookups scoring needs on top."""

    def within(self, a: float, b: float) -> float:
        """Speech seconds in ``[a, b]``."""
        return self.speech(a, b)

    def first_start(self, lo: float, hi: float) -> Optional[float]:
        """The first span start in ``[lo, hi)``."""
        k = bisect_left(self.starts, lo)
        return self.starts[k] if k < len(self.starts) and self.starts[k] < hi else None

    def last_end(self, lo: float, hi: float) -> Optional[float]:
        """The last span end in ``(lo, hi]``."""
        k = bisect_right(self.ends, hi) - 1
        return self.ends[k] if k >= 0 and self.ends[k] > lo else None

    def straddling(self, t: float) -> Optional[Span]:
        """The span that runs across ``t``, if any."""
        k = bisect_right(self.starts, t) - 1
        if k >= 0 and self.starts[k] < t < self.ends[k]:
            return self.spans[k]
        return None

    def window(self, lo: float, hi: float) -> list[Span]:
        """Spans overlapping ``[lo, hi]``."""
        k = max(0, bisect_right(self.ends, lo) - 1)
        out = []
        for a, b in self.spans[k:]:
            if a > hi:
                break
            if b >= lo:
                out.append((a, b))
        return out


# -- cases --------------------------------------------------------------------------------


@dataclass
class Case:
    """One reviewed recording: its truth regions, transcript and speech map."""

    slug: str
    path: Path
    duration: float
    cuts: list[Span]
    regions: list[Span]
    speech_map: SpeechMap
    words: list[Word]
    transcript: str
    notes: list[str]
    _spans: dict = field(default_factory=dict, repr=False)

    def spans(self, seg: dict[str, Any]) -> list[Span]:
        """Speech spans for the ``segmentation`` knobs (cached per setting)."""
        key = tuple(sorted(seg.items()))
        if key not in self._spans:
            self._spans[key] = self.speech_map.spans(**{SEG_ARGS[k]: v for k, v in seg.items()})
        return self._spans[key]


def case_dirs(cases_dir: Path, only: Sequence[str] | None = None) -> list[Path]:
    """Case directories, sorted; ``_``-prefixed ones only when named in ``only``."""
    if only:
        dirs = []
        for slug in only:
            d = cases_dir / slug
            if not (d / "project.json").is_file():
                raise SystemExit(f"error: no case {slug!r} in {cases_dir}")
            dirs.append(d)
        return dirs
    if not cases_dir.is_dir():
        raise SystemExit(f"error: cases directory not found: {cases_dir}")
    return sorted(
        d
        for d in cases_dir.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "project.json").is_file()
    )


def transcript_path(case_dir: Path, name: Optional[str]) -> Path:
    if name is None:
        return case_dir / "transcript.json"
    return case_dir / "transcripts" / f"{name}.json"


def load_case(path: Path, transcript: Optional[str] = None, with_words: bool = True) -> Case:
    """Read a case directory; ``transcript`` names a ``transcripts/NAME.json`` variant."""
    project = json.loads((path / "project.json").read_text(encoding="utf-8"))
    duration = float(project["audio_source"]["duration_sec"])
    ops = [
        EditOperation.model_validate(o)
        for o in (project.get("edl") or {}).get("operations") or []
    ]
    notes = []
    other = sorted({op.type for op in ops if op.type != "cut"})
    if other:
        notes.append(f"EDL operations other than cut are ignored by the truth: {other}")
    # An open-ended cut runs to the end of the file, as the renderer reads it.
    raw = [
        op if op.end is not None else op.model_copy(update={"end": duration})
        for op in ops
        if op.type == "cut"
    ]
    if any(op.end is None for op in ops if op.type == "cut"):
        notes.append("open-ended cuts are read as running to the end of the file")
    cuts = [(op.start, op.end) for op in normalize_cuts(raw, duration)]
    if len(cuts) < len(raw):
        notes.append(f"{len(raw)} cuts merge into {len(cuts)} (overlapping, touching or empty)")
    regions = invert_spans(cuts, duration)
    for i, (a, b) in enumerate(regions):
        if b - a < SLIVER:
            notes.append(f"region {i} [{a:.2f}-{b:.2f}] is only {b - a:.2f} s long")
        if a <= 0.0 or b >= duration:
            notes.append(f"region {i} [{a:.2f}-{b:.2f}] touches the file edge")
    words: list[Word] = []
    if with_words:
        tpath = transcript_path(path, transcript)
        if not tpath.is_file():
            raise SystemExit(f"error: {path.name}: transcript not found: {tpath}")
        _, words = load_transcript(tpath)
    return Case(
        slug=path.name,
        path=path,
        duration=duration,
        cuts=cuts,
        regions=regions,
        speech_map=SpeechMap.load(path / "source.speech.npz"),
        words=words,
        transcript=transcript or "transcript",
        notes=notes,
    )


def load_cases(
    cases_dir: Path, only: Sequence[str] | None, transcript: Optional[str] = None
) -> list[Case]:
    return [load_case(d, transcript) for d in case_dirs(cases_dir, only)]


# -- scoring ------------------------------------------------------------------------------


@dataclass
class EdgeScore:
    """A predicted cut at a kept region's start or end, measured against the truth."""

    case: str
    region: int
    kind: str  # "start" | "end"
    passage: int  # index of the passage that gives the edge
    label: str
    r: float  # the user's region boundary
    s: float  # the speech edge inside the region
    p: float  # the predicted edge
    clip: float  # speech inside the region left outside the passage
    absorbed: float  # speech of other kept regions taken into the passage
    leaked: float  # cut speech (outside every region) taken into the passage
    air: Optional[float]  # silence kept between the edge and the speech; None when not clean
    inside: bool  # the predicted edge lies inside the region's speech
    raw_absorbed: float
    raw_leaked: float

    @property
    def error(self) -> float:
        return self.clip + self.absorbed + self.leaked

    @property
    def tight(self) -> bool:
        """Less than ``TIGHT_AIR`` of air and no clip; an edge inside the speech by less
        than the noise floor counts too."""
        if self.air is not None:
            return self.air < TIGHT_AIR
        return self.inside and self.clip == 0


@dataclass
class RegionScore:
    index: int
    start: float
    end: float
    s0: float  # first speech-span start inside the region (the region start without one)
    s1: float  # last speech-span end inside the region (the region end without one)
    speech: float
    status: str  # "found" | "unsure-only" | "missed"
    passages: list[int]  # assigned passages, accepted and unsure
    accepted: list[int]
    start_edge: Optional[EdgeScore]
    end_edge: Optional[EdgeScore]
    internal: float  # speech between assigned accepted passages
    surahs: list[int]


@dataclass
class CaseScore:
    case: str
    passages: list[SurahPassage]
    assigned: list[list[int]]  # regions each passage is assigned to
    regions: list[RegionScore]
    spurious: list[int]
    mixed: list[int]
    sequence: list[dict]
    spanned: list[dict]
    notes: list[str]
    summary: dict = field(default_factory=dict)
    cost: float = 0.0
    components: dict = field(default_factory=dict)

    @property
    def edges(self) -> list[EdgeScore]:
        out = []
        for r in self.regions:
            out.extend(e for e in (r.start_edge, r.end_edge) if e is not None)
        return out


def _noise(x: float) -> float:
    return x if x >= NOISE else 0.0


def passage_label(p: SurahPassage, name: bool = False, level: bool = False) -> str:
    text = f"{p.surah}:{p.ayah_from}-{p.ayah_to}"
    if name:
        text += f" {quran.surah(p.surah).tname}"
    if level:
        text += f" ({p.level})"
    elif p.level != "accept":
        text += "?"
    return text


def assign_passages(passages: Sequence[SurahPassage], regions: Sequence[Span]) -> list[list[int]]:
    """For each passage, the regions it overlaps by at least ``ASSIGN_SHARE`` of the
    region's length or of its own."""
    out = []
    for p in passages:
        idx = []
        for i, (r0, r1) in enumerate(regions):
            ov = overlap(p.start, p.end, r0, r1)
            if ov > 0 and (ov >= ASSIGN_SHARE * (r1 - r0) or ov >= ASSIGN_SHARE * (p.end - p.start)):
                idx.append(i)
        out.append(idx)
    return out


def _outside_speech(
    sx: SpeechIndex, regions: Sequence[Span], i: int, a: float, b: float
) -> tuple[float, float]:
    """Speech in ``[a, b]`` (outside region ``i``) split into ``(absorbed, leaked)``: inside
    other regions, and outside every region."""
    total = sx.within(a, b)
    absorbed = sum(
        sx.within(max(a, r0), min(b, r1)) for j, (r0, r1) in enumerate(regions) if j != i
    )
    return absorbed, max(0.0, total - absorbed)


def _edge(
    case: str,
    regions: Sequence[Span],
    sx: SpeechIndex,
    i: int,
    kind: str,
    j: int,
    p: SurahPassage,
    s: float,
) -> EdgeScore:
    r0, r1 = regions[i]
    if kind == "start":
        r, pe = r0, p.start
        clip = sx.within(s, pe) if pe > s else 0.0
        absorbed, leaked = _outside_speech(sx, regions, i, pe, r) if pe < r else (0.0, 0.0)
        inside = pe > s
        air = s - pe
    else:
        r, pe = r1, p.end
        clip = sx.within(pe, s) if pe < s else 0.0
        absorbed, leaked = _outside_speech(sx, regions, i, r, pe) if pe > r else (0.0, 0.0)
        inside = pe < s
        air = pe - s
    clean = not inside and absorbed < AIR_MAX_SPEECH and leaked < AIR_MAX_SPEECH
    return EdgeScore(
        case=case,
        region=i,
        kind=kind,
        passage=j,
        label=passage_label(p),
        r=r,
        s=s,
        p=pe,
        clip=_noise(clip),
        absorbed=_noise(absorbed),
        leaked=_noise(leaked),
        air=air if clean else None,
        inside=inside,
        raw_absorbed=absorbed,
        raw_leaked=leaked,
    )


def longest_nondecreasing(xs: Sequence[int]) -> list[int]:
    """Indexes of one longest non-decreasing subsequence of ``xs``."""
    tails: list[int] = []
    tail_idx: list[int] = []
    prev = [-1] * len(xs)
    for i, x in enumerate(xs):
        k = bisect_right(tails, x)
        if k == len(tails):
            tails.append(x)
            tail_idx.append(i)
        else:
            tails[k] = x
            tail_idx[k] = i
        prev[i] = tail_idx[k - 1] if k else -1
    out = []
    i = tail_idx[-1] if tail_idx else -1
    while i >= 0:
        out.append(i)
        i = prev[i]
    return out[::-1]


def sequence_anomalies(passages: Sequence[SurahPassage]) -> list[dict]:
    """Accepted passages (Al-Fatihah aside) out of mushaf order, or whose ayat go back
    within a run of their surah."""
    order = [j for j, p in enumerate(passages) if p.level == "accept" and p.surah != 1]
    keep = set(longest_nondecreasing([passages[j].surah for j in order]))
    out = []
    for k, j in enumerate(order):
        if k in keep:
            continue
        before = passage_label(passages[order[k - 1]]) if k > 0 else "-"
        after = passage_label(passages[order[k + 1]]) if k + 1 < len(order) else "-"
        out.append(
            {
                "kind": "order",
                "passage": j,
                "detail": f"out of mushaf order (after {before}, before {after})",
            }
        )
    for k in range(1, len(order)):
        a, b = passages[order[k - 1]], passages[order[k]]
        if a.surah == b.surah and b.ayah_from < a.ayah_to:
            out.append(
                {
                    "kind": "ayah",
                    "passage": order[k],
                    "detail": f"ayat go back: starts at {b.ayah_from} after "
                    f"{passage_label(a)} ended at {a.ayah_to}",
                }
            )
    out.sort(key=lambda x: passages[x["passage"]].start)
    return out


def _amin(sx: SpeechIndex, r0: float, r1: float) -> Optional[tuple[float, float]]:
    """``(end of the speech before it, its start)`` for an Amin closing an Al-Fatihah region:
    the region's last span when it is short and stands apart from the span before it."""
    k = bisect_right(sx.ends, r1) - 1
    if k < 1 or sx.starts[k] < r0 or sx.ends[k - 1] <= r0:
        return None
    a, b = sx.spans[k]
    if b - a <= AMIN_MAX and a - sx.ends[k - 1] >= AMIN_GAP:
        return sx.ends[k - 1], a
    return None


def _basmala_before(case: Case, a: float, b: float) -> bool:
    """Whether the words starting in ``[a, b)`` read as a basmala."""
    from rapidfuzz import fuzz

    text = " ".join(w.text for w in case.words if a <= w.start < b)
    return bool(text) and fuzz.ratio(text, BASMALA) >= BASMALA_MATCH


def score_case(case: Case, passages: Sequence[SurahPassage], spans: Sequence[Span]) -> CaseScore:
    """Score predicted ``passages`` against the case's kept regions (see the module doc).

    The Amin that closes an Al-Fatihah and the basmala that opens it may be in or out (the
    user's rule): a Fatihah passage ending before the Amin is measured against the speech
    before it, one ending after it against the Amin's end, and only a cut inside the Amin
    counts as a clip; a Fatihah passage starting on its basmala leaks nothing.
    """
    passages = sorted(passages, key=lambda p: (p.start, p.end))
    regions = case.regions
    sx = SpeechIndex(spans)
    assigned = assign_passages(passages, regions)
    notes = list(case.notes)

    out_regions = []
    for i, (r0, r1) in enumerate(regions):
        first = sx.first_start(r0, r1)
        last = sx.last_end(r0, r1)
        s0 = first if first is not None else r0
        s1 = last if last is not None else r1
        if first is None:
            notes.append(f"region {i} [{r0:.2f}-{r1:.2f}] has no speech span inside")
        for t, side in ((r0, "start"), (r1, "end")):
            sp = sx.straddling(t)
            if sp is not None:
                notes.append(
                    f"region {i} {side} {t:.2f} cuts through speech span "
                    f"[{sp[0]:.2f}-{sp[1]:.2f}]"
                )
        mine = [j for j in range(len(passages)) if i in assigned[j]]
        acc = [j for j in mine if passages[j].level == "accept"]
        status = "found" if acc else ("unsure-only" if mine else "missed")
        start_edge = end_edge = None
        internal = 0.0
        if acc:
            jf = min(acc, key=lambda j: passages[j].start)
            jl = max(acc, key=lambda j: passages[j].end)
            if assigned[jf][0] == i:
                start_edge = _edge(case.slug, regions, sx, i, "start", jf, passages[jf], s0)
                if (
                    start_edge.raw_leaked > 0
                    and all(passages[j].surah == 1 for j in acc)
                    and _basmala_before(case, start_edge.p, r0)
                ):
                    start_edge.leaked = start_edge.raw_leaked = 0.0
                    start_edge.air = None
            if assigned[jl][-1] == i:
                s_end = s1
                amin = _amin(sx, r0, r1) if all(passages[j].surah == 1 for j in acc) else None
                if amin is not None and passages[jl].end <= amin[1] + NOISE:
                    s_end = amin[0]
                end_edge = _edge(case.slug, regions, sx, i, "end", jl, passages[jl], s_end)
            lo, hi = max(r0, passages[jf].start), min(r1, passages[jl].end)
            cover = merge_within_gap(
                sorted(
                    (max(lo, passages[j].start), min(hi, passages[j].end))
                    for j in acc
                    if overlap(passages[j].start, passages[j].end, lo, hi) > 0
                ),
                0.0,
            )
            t = lo
            for a, b in cover + [(hi, hi)]:
                if a > t:
                    internal += _noise(sx.within(t, a))
                t = max(t, b)
        for e in (start_edge, end_edge):
            if e is not None and e.air is None and e.error == 0 and not e.inside:
                notes.append(
                    f"region {i} {e.kind} edge: absorbed {e.raw_absorbed:.2f} / leaked "
                    f"{e.raw_leaked:.2f} s is under the noise floor but blocks the air"
                )
        out_regions.append(
            RegionScore(
                index=i,
                start=r0,
                end=r1,
                s0=s0,
                s1=s1,
                speech=sx.within(r0, r1),
                status=status,
                passages=mine,
                accepted=acc,
                start_edge=start_edge,
                end_edge=end_edge,
                internal=internal,
                surahs=sorted({passages[j].surah for j in mine}),
            )
        )

    spurious = [j for j, idx in enumerate(assigned) if not idx]
    mixed = [r.index for r in out_regions if len(r.surahs) > 1]
    spanned = []
    for j, p in enumerate(passages):
        if not assigned[j]:
            continue
        for a, b in case.cuts:
            if p.start < a and b < p.end:
                spanned.append({"passage": j, "cut": [a, b]})
        if len(assigned[j]) >= 3:
            notes.append(
                f"passage {passage_label(p)} [{p.start:.2f}-{p.end:.2f}] is assigned to "
                f"{len(assigned[j])} regions {assigned[j]}"
            )
    for a, b in zip(passages, passages[1:]):
        if a.end > b.start + 1e-6:
            notes.append(
                f"passages {passage_label(a)} [{a.start:.2f}-{a.end:.2f}] and "
                f"{passage_label(b)} [{b.start:.2f}-{b.end:.2f}] overlap"
            )

    score = CaseScore(
        case=case.slug,
        passages=list(passages),
        assigned=assigned,
        regions=out_regions,
        spurious=spurious,
        mixed=mixed,
        sequence=sequence_anomalies(passages),
        spanned=spanned,
        notes=notes,
    )
    score.summary = summarize([score])
    score.cost, score.components = objective(score.summary)
    return score


def summarize(scores: Sequence[CaseScore]) -> dict[str, Any]:
    """Counts and sums over the regions and edges of ``scores``."""
    regions = [r for s in scores for r in s.regions]
    edges = [e for s in scores for e in s.edges]
    starts = [e for e in edges if e.kind == "start"]
    ends = [e for e in edges if e.kind == "end"]
    airs = [e.air for e in edges if e.air is not None]
    missed = [r for r in regions if r.status != "found"]
    return {
        "regions": len(regions),
        "found": len(regions) - len(missed),
        "unsure_only": sum(r.status == "unsure-only" for r in regions),
        "missed": len(missed),
        "missed_speech": sum(r.speech for r in missed),
        "start_clip_n": sum(e.clip >= REPORT_MIN for e in starts),
        "start_clip_sum": sum(e.clip for e in starts),
        "start_clip_max": max((e.clip for e in starts), default=0.0),
        "end_clip_n": sum(e.clip >= REPORT_MIN for e in ends),
        "end_clip_sum": sum(e.clip for e in ends),
        "end_clip_max": max((e.clip for e in ends), default=0.0),
        "absorbed_n": sum(e.absorbed >= REPORT_MIN for e in edges),
        "absorbed_sum": sum(e.absorbed for e in edges),
        "leaked_n": sum(e.leaked >= REPORT_MIN for e in edges),
        "leaked_sum": sum(e.leaked for e in edges),
        "internal_sum": sum(r.internal for r in regions),
        "tight": sum(e.tight for e in edges),
        "edges": len(edges),
        "air_n": len(airs),
        "air_mean": sum(airs) / len(airs) if airs else None,
        "air_min": min(airs) if airs else None,
        "air_max": max(airs) if airs else None,
        "air_long": sum(a > AIR_LONG for a in airs),
        "air_dev": sum(abs(a - AIR_TARGET) for a in airs),
        "spurious": sum(len(s.spurious) for s in scores),
        "spurious_unsure": sum(s.passages[j].level != "accept" for s in scores for j in s.spurious),
        "mixed": sum(len(s.mixed) for s in scores),
        "sequence": sum(len(s.sequence) for s in scores),
        "spanned_cuts": sum(len(s.spanned) for s in scores),
    }


def objective(summary: dict[str, Any]) -> tuple[float, dict[str, float]]:
    """The cost (lower is better) and its weighted components."""
    comp = {
        "missed": W_MISSED * summary["missed"],
        "spurious": W_SPURIOUS * summary["spurious"],
        "mixed": W_MIXED * summary["mixed"],
        "clip": W_CLIP * (summary["start_clip_sum"] + summary["end_clip_sum"]),
        "absorbed": W_ABSORBED * summary["absorbed_sum"],
        "leaked": W_LEAKED * summary["leaked_sum"],
        "internal": W_INTERNAL * summary["internal_sum"],
        "tight": W_TIGHT * summary["tight"],
        "air": W_AIR * summary["air_dev"],
        "air_long": W_AIR_LONG * summary["air_long"],
    }
    return sum(comp.values()), comp


def match_case(case: Case, knobs: Knobs) -> tuple[list[SurahPassage], list[Span]]:
    """Run matching on a case with ``knobs``; returns the passages and the spans used."""
    surahs = dict(knobs["surahs"])
    spans = case.spans({**knobs["segmentation"], "bridge_gap": surahs.pop("bridge_gap")})
    passages = match_surahs(
        case.words, speech_spans=spans, total_duration=case.duration, **surahs
    )
    return passages, spans


def score_spans(case: Case) -> list[Span]:
    """The spans scoring measures speech with: always ``SCORE_SEG``."""
    return case.spans(SCORE_SEG)


def evaluate(cases: Sequence[Case], knobs: Knobs) -> list[CaseScore]:
    """Match every case with ``knobs`` and score it against the default spans."""
    out = []
    for case in cases:
        passages, _ = match_case(case, knobs)
        out.append(score_case(case, passages, score_spans(case)))
    return out


def total_score(scores: Sequence[CaseScore]) -> tuple[dict[str, Any], float, dict[str, float]]:
    summary = summarize(scores)
    cost, comp = objective(summary)
    return summary, cost, comp


# -- formatting ---------------------------------------------------------------------------


def hms(t: float) -> str:
    t = max(0.0, t)
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h}:{m:02d}:{s:05.2f}" if h else f"{m}:{s:05.2f}"


def fmt_dur(sec: Optional[float]) -> str:
    if sec is None:
        return "-"
    sec = int(round(sec))
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def fmt_opt(x: Optional[float], spec: str = ".2f") -> str:
    return "-" if x is None else format(x, spec)


def fmt_value(v: Any) -> str:
    return format(v, "g") if isinstance(v, float) else str(v)


def table(rows: Sequence[Sequence[Any]], header: Sequence[str], right: bool = True) -> list[str]:
    """Rows as aligned text columns (the first column left-aligned)."""
    cells = [[str(c) for c in header]] + [[str(c) for c in row] for row in rows]
    widths = [max(len(r[k]) for r in cells) for k in range(len(header))]
    lines = []
    for n, row in enumerate(cells):
        parts = []
        for k, c in enumerate(row):
            parts.append(c.ljust(widths[k]) if k == 0 or not right else c.rjust(widths[k]))
        lines.append("  ".join(parts).rstrip())
        if n == 0:
            lines.append("  ".join("-" * w for w in widths))
    return lines


def edge_text(e: Optional[EdgeScore], spans_on: str) -> str:
    """Short form of an edge for the region table."""
    if e is None:
        return spans_on
    parts = []
    if e.clip:
        parts.append(f"clip {e.clip:.2f}")
    if e.absorbed:
        parts.append(f"abs {e.absorbed:.2f}")
    if e.leaked:
        parts.append(f"leak {e.leaked:.2f}")
    if e.air is not None:
        parts.append(f"air {e.air:.2f}")
    elif not parts and e.inside:
        parts.append(f"inside {abs(e.p - e.s):.2f}")
    if e.tight:
        parts.append("tight")
    return " ".join(parts) or "air -"


def format_case(case: Case, score: CaseScore) -> list[str]:
    """The per-region table and the anomalies of one case."""
    lines = [
        f"== {case.slug}  ({hms(case.duration)}, {len(case.regions)} regions, "
        f"{case.transcript}, {len(case.words)} words, {len(score.passages)} passages)"
    ]
    rows = []
    for r in score.regions:
        if r.status == "found":
            st = edge_text(r.start_edge, "(earlier region)")
            en = edge_text(r.end_edge, "(later region)")
        else:
            st = en = ""
        rows.append(
            [
                r.index,
                f"{r.start:.2f}-{r.end:.2f}",
                f"{r.end - r.start:.1f}",
                f"{r.speech:.1f}",
                f"{r.s0 - r.start:.2f}",
                f"{r.end - r.s1:.2f}",
                r.status,
                st,
                en,
                f"{r.internal:.2f}" if r.internal else "",
                ", ".join(passage_label(score.passages[j]) for j in r.passages),
            ]
        )
    head = ["#", "region", "len", "speech", "lead", "tail", "status", "start edge", "end edge",
            "int", "passages"]
    for line in table(rows, head, right=False):
        lines.append("  " + line)
    for j in score.spurious:
        p = score.passages[j]
        lines.append(
            f"  spurious: {passage_label(p, name=True, level=True)} "
            f"[{p.start:.2f}-{p.end:.2f}] lies in cut audio"
        )
    for i in score.mixed:
        r = score.regions[i]
        labels = ", ".join(passage_label(score.passages[j], name=True) for j in r.passages)
        lines.append(f"  mixed: region {i} [{r.start:.2f}-{r.end:.2f}]: {labels}")
    for a in score.sequence:
        p = score.passages[a["passage"]]
        lines.append(
            f"  sequence: {passage_label(p, name=True)} [{p.start:.2f}-{p.end:.2f}] {a['detail']}"
        )
    for s in score.spanned:
        p = score.passages[s["passage"]]
        a, b = s["cut"]
        lines.append(
            f"  spanned cut: {passage_label(p)} [{p.start:.2f}-{p.end:.2f}] spans the cut "
            f"[{a:.2f}-{b:.2f}] ({b - a:.1f} s)"
        )
    for n in score.notes:
        lines.append(f"  note: {n}")
    return lines


COMPONENTS = ("missed", "spurious", "mixed", "clip", "absorbed", "leaked", "internal", "tight",
              "air", "air_long")


def format_summary(scores: Sequence[CaseScore]) -> list[str]:
    """The summary tables per case and in total, then the objective components."""
    entries = [(s.case, s.summary, s.cost, s.components) for s in scores]
    if len(scores) > 1:
        entries.append(("TOTAL", *total_score(scores)))
    lines = ["== summary  (missed counts regions with no accepted passage; unsure-only is the "
             "subset with an unsure one)"]
    rows = [
        [
            name,
            m["regions"],
            m["found"],
            m["unsure_only"],
            m["missed"],
            f"{m['missed_speech']:.1f}",
            f"{m['spurious']}" + (f" ({m['spurious_unsure']}u)" if m["spurious_unsure"] else ""),
            m["mixed"],
            m["sequence"],
            m["spanned_cuts"],
        ]
        for name, m, _, _ in entries
    ]
    lines += table(rows, ["case", "regions", "found", "unsure-only", "missed", "missed s",
                          "spurious", "mixed", "sequence", "spanned cuts"])
    lines.append("")
    rows = [
        [
            name,
            f"{m['start_clip_n']}/{m['start_clip_sum']:.2f}/{m['start_clip_max']:.2f}",
            f"{m['end_clip_n']}/{m['end_clip_sum']:.2f}/{m['end_clip_max']:.2f}",
            f"{m['absorbed_n']}/{m['absorbed_sum']:.2f}",
            f"{m['leaked_n']}/{m['leaked_sum']:.2f}",
            f"{m['internal_sum']:.2f}",
            m["tight"],
            f"{fmt_opt(m['air_mean'])}/{fmt_opt(m['air_min'])}/{fmt_opt(m['air_max'])}",
            f"{m['air_n']}/{m['edges']}",
            m["air_long"],
        ]
        for name, m, _, _ in entries
    ]
    lines += table(rows, ["case", "start clip n/sum/max", "end clip n/sum/max", "absorbed n/sum",
                          "leaked n/sum", "internal", "tight", "air mean/min/max",
                          "clean/edges", f"air>{AIR_LONG:g}"])
    lines.append("")
    rows = [
        [name, f"{cost:.2f}", *(f"{comp[k]:.2f}" for k in COMPONENTS)]
        for name, _, cost, comp in entries
    ]
    lines += table(rows, ["case", "cost", *COMPONENTS])
    lines.append(
        f"   cost = {W_MISSED:g}*missed + {W_SPURIOUS:g}*spurious + {W_MIXED:g}*mixed + "
        f"{W_CLIP:g}*clip + {W_ABSORBED:g}*absorbed + {W_LEAKED:g}*leaked + "
        f"{W_INTERNAL:g}*internal + {W_TIGHT:g}*tight + {W_AIR:g}*sum|air-{AIR_TARGET:g}| + "
        f"{W_AIR_LONG:g}*(air>{AIR_LONG:g})  (counts at >= {REPORT_MIN:g} s, noise < {NOISE:g} s)"
    )
    return lines


def _bar(a: float, b: float, lo: float, hi: float, ch: str) -> str:
    cells = [" "] * BAR_WIDTH
    width = hi - lo
    if width <= 0:
        return "".join(cells)
    i0 = int((max(a, lo) - lo) / width * BAR_WIDTH)
    i1 = int(math.ceil((min(b, hi) - lo) / width * BAR_WIDTH))
    i0 = min(max(i0, 0), BAR_WIDTH - 1)
    i1 = min(max(i1, i0 + 1), BAR_WIDTH)
    for k in range(i0, i1):
        cells[k] = ch
    return "".join(cells)


def format_window(
    case: Case, score: CaseScore, spans: Sequence[Span], lo: float, hi: float
) -> list[str]:
    """Region, speech and predicted edges, speech spans and transcript words in
    ``[lo, hi]``, one per line in time order."""
    events: list[tuple[float, int, str, str]] = []

    def mark(t: float, ch: str, text: str) -> None:
        if lo <= t <= hi:
            events.append((t, 0, _bar(t, t, lo, hi, ch), text))

    for r in score.regions:
        mark(r.start, "R", f"|R start of region {r.index}")
        mark(r.end, "R", f"|R end of region {r.index}")
        if r.s0 != r.start:
            mark(r.s0, "S", f"|S speech start of region {r.index}")
        if r.s1 != r.end:
            mark(r.s1, "S", f"|S speech end of region {r.index}")
    for p in score.passages:
        mark(p.start, "P", f"|P start of {passage_label(p, name=True, level=True)}")
        mark(p.end, "P", f"|P end of {passage_label(p, name=True, level=True)}")
    for a, b in SpeechIndex(spans).window(lo, hi):
        events.append((a, 1, _bar(a, b, lo, hi, "#"), f"span {a:.2f}-{b:.2f} ({b - a:.2f} s)"))
    accepted = [(p.start, p.end) for p in score.passages if p.level == "accept"]
    for w in case.words:
        if w.end < lo or w.start > hi:
            continue
        mid = (w.start + w.end) / 2
        star = "*" if any(a <= mid <= b for a, b in accepted) else " "
        kept = "k" if any(a <= mid <= b for a, b in case.regions) else "-"
        text = f"{star} {kept} {w.start:.2f}-{w.end:.2f} {w.probability:.2f}  {w.text}  ({w.raw})"
        events.append((w.start, 2, _bar(w.start, w.end, lo, hi, "="), text))
    events.sort(key=lambda e: (e[0], e[1]))
    step = (hi - lo) / BAR_WIDTH
    # A "+" in each cell where a whole second begins.
    ruler = "".join(
        "+" if math.floor(lo + (k + 1) * step) > math.floor(lo + k * step) else " "
        for k in range(BAR_WIDTH)
    )
    lines = [f"  {lo:9.2f} |{ruler}| window {lo:.2f} .. {hi:.2f} (+ each second)"]
    for t, _, bar, text in events:
        lines.append(f"  {t:9.2f} |{bar}| {text}")
    return lines


def format_edge(score: CaseScore, e: EdgeScore, rank: Optional[int] = None) -> list[str]:
    r = score.regions[e.region]
    labels = ", ".join(passage_label(score.passages[j], name=True, level=True) for j in r.passages)
    prefix = f"#{rank}  " if rank is not None else ""
    return [
        f"{prefix}{e.case}  region {e.region} [{r.start:.2f}-{r.end:.2f}] "
        f"({hms(r.start)}, {r.end - r.start:.1f} s)  {e.kind.upper()} edge  {labels}",
        f"    predicted {e.p:.2f} ({hms(e.p)})  speech edge {e.s:.2f}  region edge {e.r:.2f}  "
        f"p-s {e.p - e.s:+.2f}  p-r {e.p - e.r:+.2f}",
        f"    clip {e.clip:.2f}  absorbed {e.absorbed:.2f}  leaked {e.leaked:.2f}  "
        f"air {fmt_opt(e.air)}" + ("  TIGHT" if e.tight else ""),
    ]


WINDOW_LEGEND = (
    "  legend: R region boundary, S speech edge, P predicted edge, # speech span, = word; "
    "* word inside an accepted passage, k kept by the user, - cut"
)


def rank_edges(scores: Sequence[CaseScore]) -> list[EdgeScore]:
    """All edges, worst first: by clip + absorbed + leaked, then tight, then air off target."""
    edges = [e for s in scores for e in s.edges]
    return sorted(
        edges,
        key=lambda e: (
            -e.error,
            not e.tight,
            -(abs(e.air - AIR_TARGET) if e.air is not None else 0.0),
        ),
    )


def score_to_json(case: Case, score: CaseScore) -> dict[str, Any]:
    def edge(e: Optional[EdgeScore]) -> Optional[dict]:
        if e is None:
            return None
        return {**asdict(e), "error": e.error, "tight": e.tight}

    return {
        "case": case.slug,
        "transcript": case.transcript,
        "cost": score.cost,
        "components": score.components,
        "summary": score.summary,
        "regions": [
            {
                "index": r.index,
                "start": r.start,
                "end": r.end,
                "s0": r.s0,
                "s1": r.s1,
                "speech": r.speech,
                "status": r.status,
                "passages": [passage_label(score.passages[j]) for j in r.passages],
                "start_edge": edge(r.start_edge),
                "end_edge": edge(r.end_edge),
                "internal": r.internal,
                "surahs": r.surahs,
            }
            for r in score.regions
        ],
        "passages": [
            {**p.model_dump(), "regions": score.assigned[j]} for j, p in enumerate(score.passages)
        ],
        "spurious": score.spurious,
        "mixed": score.mixed,
        "sequence": score.sequence,
        "spanned_cuts": score.spanned,
        "notes": score.notes,
    }


# -- commands -----------------------------------------------------------------------------


def cmd_truth(args: argparse.Namespace) -> int:
    knobs = apply_settings(default_knobs(), args.set, ("segmentation",))
    for d in case_dirs(args.cases, args.case):
        case = load_case(d, with_words=False)
        spans = case.spans(knobs["segmentation"])
        sx = SpeechIndex(spans)
        kept = sum(b - a for a, b in case.regions)
        speech = sum(sx.within(a, b) for a, b in case.regions)
        print(
            f"== {case.slug}  duration {hms(case.duration)} ({case.duration:.2f} s)  "
            f"cuts {len(case.cuts)}  kept regions {len(case.regions)} "
            f"({kept:.1f} s, speech {speech:.1f} s)"
        )
        rows = []
        for i, (a, b) in enumerate(case.regions):
            first, last = sx.first_start(a, b), sx.last_end(a, b)
            flags = []
            for t, side in ((a, "start"), (b, "end")):
                sp = sx.straddling(t)
                if sp is not None:
                    flags.append(f"{side} cuts span [{sp[0]:.2f}-{sp[1]:.2f}]")
            n_spans = sum(1 for s0, s1 in sx.window(a, b) if s0 >= a and s1 <= b)
            rows.append(
                [
                    i,
                    hms(a),
                    f"{a:.2f}",
                    f"{b:.2f}",
                    f"{b - a:.2f}",
                    f"{first - a:+.2f}" if first is not None else "-",
                    f"{last - b:+.2f}" if last is not None else "-",
                    f"{sx.within(a, b):.1f}",
                    n_spans,
                    "; ".join(flags),
                ]
            )
        head = ["#", "at", "start", "end", "length", "first span", "last span", "speech",
                "spans", "notes"]
        for line in table(rows, head):
            print("  " + line)
        for n in case.notes:
            print(f"  note: {n}")
        print()
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    base = default_knobs()
    knobs = apply_settings(base, args.set, ("surahs", "segmentation"))
    cases = load_cases(args.cases, args.case, args.transcript)
    scores = evaluate(cases, knobs)
    by_slug = {c.slug: c for c in cases}
    diff = knob_diff(knobs, base)
    print(
        f"settings: {', '.join(f'{k}={fmt_value(v)}' for k, v in diff.items()) or 'defaults'}"
        f"  transcript: {args.transcript or 'transcript.json'}"
    )
    print()
    if not args.quiet:
        for case, score in zip(cases, scores):
            for line in format_case(case, score):
                print(line)
            print()
        worst = rank_edges(scores)[: args.worst]
        if worst:
            print(f"== {len(worst)} worst edges")
            print(WINDOW_LEGEND)
            shown: dict[tuple[str, float], int] = {}
            for n, e in enumerate(worst, 1):
                case = by_slug[e.case]
                score = scores[cases.index(case)]
                print()
                for line in format_edge(score, e, n):
                    print(line)
                if (e.case, e.p) in shown:
                    print(f"    (window as in #{shown[e.case, e.p]})")
                    continue
                shown[e.case, e.p] = n
                spans = case.spans(knobs["segmentation"])
                for line in format_window(case, score, spans, e.p - args.window, e.p + args.window):
                    print(line)
            print()
    for line in format_summary(scores):
        print(line)
    if args.json:
        summary, cost, comp = total_score(scores)
        data = {
            "settings": knobs,
            "changed": diff,
            "transcript": args.transcript or "transcript",
            "cases": [score_to_json(c, s) for c, s in zip(cases, scores)],
            "total": {"cost": cost, "components": comp, "summary": summary},
        }
        Path(args.json).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


def cmd_edges(args: argparse.Namespace) -> int:
    if not args.case or len(args.case) != 1:
        raise SystemExit("error: edges needs exactly one --case")
    knobs = apply_settings(default_knobs(), args.set, ("surahs", "segmentation"))
    case = load_case(case_dirs(args.cases, args.case)[0], args.transcript)
    passages, spans = match_case(case, knobs)
    score = score_case(case, passages, score_spans(case))
    lo, hi = args.at - args.window, args.at + args.window
    print(f"== {case.slug} at {args.at:.2f} ({hms(args.at)})  transcript: {case.transcript}")
    for r in score.regions:
        if overlap(r.start, r.end, lo, hi) > 0 or r.start <= args.at <= r.end:
            labels = ", ".join(passage_label(score.passages[j], name=True, level=True)
                               for j in r.passages)
            print(f"  region {r.index} [{r.start:.2f}-{r.end:.2f}] {r.status}  {labels}")
    for e in score.edges:
        if any(lo <= t <= hi for t in (e.p, e.s, e.r)):
            for line in format_edge(score, e):
                print(f"  {line}")
    print(WINDOW_LEGEND)
    for line in format_window(case, score, spans, lo, hi):
        print(line)
    return 0


def _sweep_row(label: str, values: dict[str, Any], scores: Sequence[CaseScore]) -> dict:
    _, cost, comp = total_score(scores)
    return {
        "label": label,
        "values": values,
        "cost": cost,
        "components": comp,
        "cases": {s.case: s.cost for s in scores},
    }


def format_sweep(rows: Sequence[dict], keys: Sequence[str], slugs: Sequence[str]) -> list[str]:
    body = [
        [
            row["label"],
            *(fmt_value(row["values"][k]) for k in keys),
            f"{row['cost']:.2f}",
            *(f"{row['components'][k]:.1f}" for k in COMPONENTS),
            *(f"{row['cases'][s]:.2f}" for s in slugs),
        ]
        for row in rows
    ]
    return table(body, ["rank", *keys, "cost", *COMPONENTS, *slugs])


def cmd_sweep(args: argparse.Namespace) -> int:
    grid = parse_grid(args.grid)
    base = apply_settings(default_knobs(), args.set, ("surahs", "segmentation"))
    cases = load_cases(args.cases, args.case, args.transcript)
    slugs = [c.slug for c in cases]
    keys = [f"{s}.{k}" for s, k, _ in grid]
    cache: dict[tuple, dict] = {}

    def run(values: dict[str, Any], label: str = "") -> dict:
        key = tuple(values[k] for k in keys)
        if key not in cache:
            knobs = {s: dict(v) for s, v in base.items()}
            for name, v in values.items():
                section, k = name.split(".", 1)
                knobs[section][k] = v
            cache[key] = _sweep_row(label, dict(values), evaluate(cases, knobs))
        return cache[key]

    start = {f"{s}.{k}": base[s][k] for s, k, _ in grid}
    t0 = time.monotonic()
    base_row = dict(run(start), label="base")
    if args.set:
        print(f"base: defaults with {', '.join(args.set)}")
    if args.coordinate:
        current = dict(start)
        best = base_row["cost"]
        rnd = 0
        while True:
            rnd += 1
            improved = False
            for (section, k, values), name in zip(grid, keys):
                trials = []
                for v in values:
                    row = run({**current, name: v})
                    trials.append((row["cost"], v))
                cost, v = min(trials, key=lambda t: t[0])
                tried = "  ".join(f"{fmt_value(x)}:{c:.2f}" for c, x in trials)
                moved = cost < best - 1e-9
                print(f"round {rnd}  {name}  {tried}  -> {fmt_value(v if moved else current[name])}")
                if moved:
                    current[name] = v
                    best = cost
                    improved = True
            if not improved:
                break
        print(f"coordinate descent: {len(cache)} settings in {time.monotonic() - t0:.1f} s; "
              f"best cost {best:.2f} (base {base_row['cost']:.2f})")
        print("best: " + ", ".join(f"{k}={fmt_value(v)}" for k, v in current.items()))
    else:
        combos = list(itertools.product(*(values for _, _, values in grid)))
        live = sys.stderr.isatty()
        for n, combo in enumerate(combos, 1):
            run(dict(zip(keys, combo)))
            if live:
                print(f"\r[{n}/{len(combos)}] {time.monotonic() - t0:.0f} s", end="",
                      file=sys.stderr, flush=True)
        if live:
            print(file=sys.stderr)
        print(f"grid: {len(combos)} settings in {time.monotonic() - t0:.1f} s")
    rows = sorted(cache.values(), key=lambda r: r["cost"])[: args.top]
    ranked = [dict(r, label=str(n)) for n, r in enumerate(rows, 1)]
    print()
    for line in format_sweep([base_row, *ranked], keys, slugs):
        print(line)
    print("   components are weighted (they sum to the cost); the case columns are per-case costs")
    return 0


def cmd_transcribe(args: argparse.Namespace) -> int:
    name = args.variant
    if not name or any(c in name for c in '\\/:*?"<>|') or name.startswith("."):
        raise SystemExit(f"error: invalid variant name {name!r}")
    knobs = apply_settings(default_knobs(), args.set, ("transcription", "segmentation"))
    if args.model_dir:
        model_path = Path(args.model_dir).resolve()
        if not model_path.is_dir():
            raise SystemExit(f"error: model directory not found: {model_path}")
        model, models_dir, label = str(model_path), None, str(model_path)
    else:
        model, models_dir = base_config().surahs.model, runtime.models_dir()
        model_path = whisper_models.model_dir(model, models_dir)
        label = model
    print(f"model: {model_path}")
    print(f"transcription: {knobs['transcription']}")
    print(f"segmentation: {knobs['segmentation']}", flush=True)
    for d in case_dirs(args.cases, args.case):
        out = d / "transcripts" / f"{name}.json"
        if out.exists() and not args.force:
            print(f"[{d.name}] {out} exists; skipped (--force to redo)", flush=True)
            continue
        case = load_case(d, with_words=False)
        spans = case.spans(knobs["segmentation"])
        t0 = time.monotonic()
        state = {"last": -1e9, "total": 0.0}

        def progress(ev: dict, slug: str = case.slug, t0: float = t0, state: dict = state) -> None:
            done, total = float(ev.get("done_sec", 0.0)), float(ev.get("total_sec", 0.0))
            state["total"] = total
            now = time.monotonic()
            if now - state["last"] < args.progress_every and done < total:
                return
            state["last"] = now
            frac = done / total if total else 0.0
            elapsed = now - t0
            eta = elapsed * (1 - frac) / frac if frac > 0.005 else None
            print(
                f"[{slug}] {frac:6.1%}  {done:7.0f}/{total:.0f} s of clips  "
                f"elapsed {fmt_dur(elapsed)}  eta {fmt_dur(eta)}",
                flush=True,
            )

        print(f"[{case.slug}] transcribing {hms(case.duration)} of audio, {len(spans)} spans",
              flush=True)
        words = transcribe(
            d / "source.work.wav",
            model=model,
            models_dir=models_dir,
            speech_spans=spans,
            total_duration=case.duration,
            ffmpeg_bin=base_config().ffmpeg.bin,
            progress=progress,
            **knobs["transcription"],
        )
        elapsed = time.monotonic() - t0
        out.parent.mkdir(parents=True, exist_ok=True)
        save_transcript(out, label, words)
        meta = {
            "variant": name,
            "case": case.slug,
            "model": label,
            "model_dir": str(model_path),
            "transcription": knobs["transcription"],
            "segmentation": knobs["segmentation"],
            "elapsed_sec": round(elapsed, 1),
            "audio_duration_sec": case.duration,
            "clip_sec": state["total"],
            "words": len(words),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        out.with_name(f"{name}.meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        print(f"[{case.slug}] {len(words)} words in {fmt_dur(elapsed)} -> {out}", flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--cases", type=Path, default=DEFAULT_CASES,
                        help=f"cases directory (default {DEFAULT_CASES})")
    common.add_argument("--case", action="append", metavar="SLUG",
                        help="restrict to this case (repeatable); names a _-prefixed one too")
    matching = argparse.ArgumentParser(add_help=False)
    matching.add_argument("--transcript", metavar="NAME",
                          help="use transcripts/NAME.json instead of transcript.json")
    matching.add_argument("--set", action="append", metavar="SECTION.KEY=VALUE",
                          help="override a surahs.* or segmentation.* knob (repeatable)")

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("truth", parents=[common], help="print the kept regions")
    p.add_argument("--set", action="append", metavar="SECTION.KEY=VALUE",
                   help="override a segmentation.* knob (repeatable)")
    p.set_defaults(func=cmd_truth)

    p = sub.add_parser("score", parents=[common, matching], help="score matching against truth")
    p.add_argument("--worst", type=int, default=12, help="drill into the N worst edges")
    p.add_argument("--window", type=float, default=8.0, help="seconds each side of an edge")
    p.add_argument("--json", metavar="PATH", help="write per-case and per-region results")
    p.add_argument("--quiet", action="store_true", help="print only the summary tables")
    p.set_defaults(func=cmd_score)

    p = sub.add_parser("sweep", parents=[common, matching], help="score a grid of settings")
    p.add_argument("--grid", action="append", required=True, metavar="SECTION.KEY=V1,V2",
                   help="values to try for a knob (repeatable)")
    p.add_argument("--top", type=int, default=20, help="rows to print")
    p.add_argument("--coordinate", action="store_true",
                   help="vary one knob at a time from the base until nothing improves")
    p.set_defaults(func=cmd_sweep)

    p = sub.add_parser("edges", parents=[common, matching], help="drill down at a time point")
    p.add_argument("--at", type=float, required=True, metavar="SECONDS")
    p.add_argument("--window", type=float, default=8.0, help="seconds each side")
    p.set_defaults(func=cmd_edges)

    p = sub.add_parser("transcribe", parents=[common], help="write a transcript variant")
    p.add_argument("--variant", required=True, metavar="NAME")
    p.add_argument("--set", action="append", metavar="SECTION.KEY=VALUE",
                   help="override a transcription.* or segmentation.* knob (repeatable)")
    p.add_argument("--model-dir", metavar="PATH",
                   help="a CTranslate2 Whisper model directory (default: the installed "
                        f"{base_config().surahs.model})")
    p.add_argument("--force", action="store_true", help="redo a variant that exists")
    p.add_argument("--progress-every", type=float, default=15.0, metavar="SECONDS",
                   help="seconds between progress lines")
    p.set_defaults(func=cmd_transcribe)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KnobError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
