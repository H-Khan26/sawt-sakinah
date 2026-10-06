"""Spoken-phrase detection (Arabic takbir and recurring utterances).

Finds occurrences of known prayer phrases -- the takbir ("Allahu Akbar") that announces
every position transition, plus tasmi'/tahmid/tasleem -- and returns timestamped
``Marker``s. Pure analysis: reads the audio and returns data, never mutates or writes.
The ordered marker stream feeds the prayer state machine and the waveform UI. See
docs/audio/03-phrase-detection.md.

Baseline backend (``detector="whisper"``): transcribe with an Arabic Whisper model and
word-level timestamps, biasing the decoder toward the target phrases via the initial
prompt, then fuzzy-match each phrase against the normalized word stream.

When the caller supplies the source's fine speech spans (from ``segmentation.py``) two
things change. The spans are grouped into padded clips, the clip audio is concatenated
and transcribed as one stream with Whisper's own VAD disabled, and word times are mapped
back to source time through the clip offsets. Concatenating (rather than handing Whisper
per-clip ``clip_timestamps``) matters for cost: the encoder always processes 30 s
windows, so isolated short clips would each pay for a full window, while one packed
stream is decoded in as few windows as the speech itself needs. Second, each marker's
onset/end is snapped to the nearest speech-span edge within ``snap_window``, which turns
Whisper's coarse word timing into a real speech onset for takbirs that follow a pause.
Phrases that run straight into the next utterance have no edge to snap to and keep
their Whisper timing. Without spans (no speech map available) the whole file is
transcribed with Whisper's built-in VAD and onsets stay coarse (~+-0.5 s).

The model dependencies (``faster-whisper`` + ``rapidfuzz``) are optional; install them
with the project's ``phrases`` extra (``pip install -e ".[phrases]"``). They are imported
lazily so the rest of the package never needs them.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from pathlib import Path

from ..config import CONFIG
from ..models import Marker
from ._arabic import PHRASE_REGISTRY, PhraseSpec, normalize_arabic
from ._pcm import SAMPLE_RATE, decode_pcm
from ._spans import Span, merge_within_gap, pad_spans

# Cache loaded Whisper models across calls, keyed by (model_size, device, compute_type).
# Loading large-v3 is expensive; detect_phrases stays read-only otherwise.
_MODEL_CACHE: dict[tuple[str, str, str], object] = {}

# Confidence blend and gating thresholds (0..100 for RapidFuzz scores), sourced from the
# single config file; exposed indirectly through min_confidence.
_KEYWORD_GATE = CONFIG.phrases.keyword_gate  # each required keyword must partial-match this
_FUZZY_FLOOR = CONFIG.phrases.fuzzy_floor    # whole-phrase token_sort_ratio floor
_FUZZY_WEIGHT = CONFIG.phrases.fuzzy_weight  # confidence = _FUZZY_WEIGHT*fuzzy + (1-w)*prob


def _default_initial_prompt() -> str:
    """Biased decoder prompt listing the canonical phrases (raw Arabic, with diacritics)."""
    return "الله أكبر. سمع الله لمن حمده. ربنا ولك الحمد. السلام عليكم ورحمة الله."


def _get_model(model_size: str, device: str, compute_type: str):
    key = (model_size, device, compute_type)
    model = _MODEL_CACHE.get(key)
    if model is None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as err:  # pragma: no cover - exercised only without the extra
            raise RuntimeError(
                "Phrase detection requires the optional 'phrases' extra "
                '(pip install -e ".[phrases]": faster-whisper + rapidfuzz).'
            ) from err
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _MODEL_CACHE[key] = model
    return model


# One entry per concatenated clip: (start in the packed stream, source start, source end).
_ClipOffset = tuple[float, float, float]


def _pack_clips(
    input_path: Path, clips: list[Span], ffmpeg_bin: str
) -> tuple[object, list[_ClipOffset]]:
    """Decode ``input_path`` and concatenate the ``clips`` into one 16 kHz float32 stream.

    Returns the packed audio plus the offset table needed to map packed-stream times
    back to source time. Clips are ordered and non-overlapping (see ``_clips_from_spans``)
    so the packed stream preserves source order.
    """
    import numpy as np

    audio = decode_pcm(input_path, ffmpeg_bin)
    pieces = []
    offsets: list[_ClipOffset] = []
    packed_start = 0.0
    for start, end in clips:
        a = min(len(audio), max(0, int(round(start * SAMPLE_RATE))))
        b = min(len(audio), max(a, int(round(end * SAMPLE_RATE))))
        if b <= a:
            continue
        pieces.append(audio[a:b])
        offsets.append((packed_start, a / SAMPLE_RATE, b / SAMPLE_RATE))
        packed_start += (b - a) / SAMPLE_RATE
    if not pieces:
        return np.zeros(0, dtype=np.float32), offsets
    return np.concatenate(pieces), offsets


def _to_source_time(offsets: list[_ClipOffset], start: float, end: float) -> Span:
    """Map a packed-stream word interval back to source time.

    The clip is chosen by the word's midpoint, and both edges are shifted by that clip's
    offset and clamped to it, so a word that Whisper places across a clip seam cannot
    straddle two distant source regions.
    """
    packed_starts = [o[0] for o in offsets]
    mid = (start + end) / 2.0
    i = max(0, bisect_right(packed_starts, mid) - 1)
    packed_start, src_start, src_end = offsets[i]
    shift = src_start - packed_start
    a = min(src_end, max(src_start, start + shift))
    b = min(src_end, max(a, end + shift))
    return a, b


def _transcribe_words(
    model,
    input_path: Path,
    language: str,
    initial_prompt: str,
    vad_filter: bool,
    clips: list[Span] | None,
    ffmpeg_bin: str,
) -> list[tuple[str, float, float, float]]:
    """Return a flat word stream as (normalized_text, start, end, probability) in source time.

    With ``clips`` the clip audio is packed into one stream and Whisper's built-in VAD is
    bypassed (the clips already are the speech); without them the whole file is handed
    to Whisper with ``vad_filter`` as configured.
    """
    offsets: list[_ClipOffset] | None = None
    if clips is None:
        audio = str(input_path)
        run_vad = vad_filter
    else:
        audio, offsets = _pack_clips(input_path, clips, ffmpeg_bin)
        run_vad = False
        if not offsets:
            return []
    segments, _info = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        initial_prompt=initial_prompt,
        vad_filter=run_vad,
    )
    words: list[tuple[str, float, float, float]] = []
    for seg in segments:
        for w in seg.words or []:
            norm = normalize_arabic(w.word.strip())
            if not norm:
                continue
            prob = float(getattr(w, "probability", None) or 0.0)
            start, end = float(w.start), float(w.end)
            if offsets is not None:
                start, end = _to_source_time(offsets, start, end)
            words.append((norm, start, end, prob))
    return words


def _clips_from_spans(
    spans: list[Span], merge_gap: float, pad: float, total: float | None
) -> list[Span]:
    """Group fine speech spans into padded, non-overlapping Whisper clips.

    Spans closer than ``merge_gap`` become one clip so a phrase split by a short
    breath is decoded in one window; ``pad`` adds acoustic context on both sides
    (clamped to the file), and a final zero-gap merge removes overlaps the padding
    created.
    """
    clips = merge_within_gap(sorted(spans), merge_gap)
    clips = pad_spans(clips, pad, total)
    return merge_within_gap(clips, 0.0)


def _nearest_within(values: list[float], t: float, window: float) -> float | None:
    """Return the element of sorted ``values`` closest to ``t`` if within ``window``.

    Only the two neighbours straddling ``t`` can be nearest. When both are exactly
    equidistant the earlier one wins: candidates are visited in ascending order and a
    later one replaces the current best only when strictly closer. The rule is exact
    (no tolerance), so the result is deterministic for identical inputs.
    """
    i = bisect_left(values, t)
    best: float | None = None
    for j in (i - 1, i):
        if 0 <= j < len(values) and abs(values[j] - t) <= window:
            if best is None or abs(values[j] - t) < abs(best - t):
                best = values[j]
    return best


def _snap_markers(markers: list[Marker], spans: list[Span], window: float) -> list[Marker]:
    """Snap each marker's onset to the nearest span start and its end to the nearest span end.

    Only edges within ``window`` seconds count, so a phrase inside a long speech run
    (no nearby edge) is left alone. A snap is skipped when it would invert the marker
    (end <= time). ``Marker.id`` is derived from the onset, so a moved marker is
    rebuilt through validation rather than copied, keeping the id consistent.
    """
    starts = sorted(s for s, _ in spans)
    ends = sorted(e for _, e in spans)
    out: list[Marker] = []
    for m in markers:
        time = m.time
        end = m.end
        snapped_start = _nearest_within(starts, m.time, window)
        if snapped_start is not None and (end is None or snapped_start < end):
            time = snapped_start
        if end is not None:
            snapped_end = _nearest_within(ends, end, window)
            if snapped_end is not None and snapped_end > time:
                end = snapped_end
        if time == m.time and end == m.end:
            out.append(m)
            continue
        data = m.model_dump(exclude={"id", "duration"})
        out.append(Marker.model_validate({**data, "time": time, "end": end}))
    out.sort(key=lambda m: m.time)
    return out


def _candidates_for_spec(
    spec: PhraseSpec,
    words: list[tuple[str, float, float, float]],
    max_word_gap: float,
):
    """Yield (start, end, confidence) for every window matching ``spec``.

    A window only counts when its words are temporally contiguous (no inter-word gap
    larger than ``max_word_gap``), so filler words far from the phrase cannot be stitched
    into a false match.
    """
    from rapidfuzz import fuzz

    n_tokens = max(len(spec.keywords), len(spec.canonical.split()))
    sizes = range(max(1, n_tokens - 1), n_tokens + 3)  # tolerate splits/elongation

    for i in range(len(words)):
        for size in sizes:
            window = words[i : i + size]
            if len(window) < size:
                break

            # Contiguity: a multi-word phrase must not span a long silence/other speech.
            # Any larger window includes this same gap, so break (not continue) on failure.
            if any(
                window[j + 1][1] - window[j][2] > max_word_gap
                for j in range(len(window) - 1)
            ):
                break

            text = " ".join(w[0] for w in window)

            # Cheap high-precision gate: every required keyword must appear (fuzzily).
            if any(fuzz.partial_ratio(kw, text) < _KEYWORD_GATE for kw in spec.keywords):
                continue

            fuzzy = fuzz.token_sort_ratio(spec.canonical, text)
            if fuzzy < _FUZZY_FLOOR:
                continue

            mean_prob = sum(w[3] for w in window) / len(window)
            confidence = (
                _FUZZY_WEIGHT * (fuzzy / 100.0)
                + (1.0 - _FUZZY_WEIGHT) * mean_prob
            )
            yield window[0][1], window[-1][2], confidence


def _dedupe(
    cands: list[tuple[str, str, float, float, float]],
    min_gap: float,
) -> list[Marker]:
    """Greedy NMS per phrase type.

    Keeps the highest-confidence candidate, then suppresses any later same-type
    candidate that overlaps it in time or whose onset falls within ``min_gap``. This
    collapses the overlapping sub-/super-windows that match a single utterance.
    """
    cands = sorted(cands, key=lambda c: c[4], reverse=True)  # by confidence desc
    accepted: list[tuple[str, str, float, float, float]] = []
    for cand in cands:
        ptype, _label, start, end, _conf = cand
        clash = any(
            a[0] == ptype
            and (
                abs(a[2] - start) < min_gap          # onsets too close
                or (start < a[3] and a[2] < end)     # time ranges overlap
            )
            for a in accepted
        )
        if not clash:
            accepted.append(cand)

    markers = [
        Marker(time=start, label=label, type=ptype, confidence=round(conf, 4), end=end)
        for ptype, label, start, end, conf in accepted
    ]
    markers.sort(key=lambda m: m.time)
    return markers


def detect_phrases(
    input_path: str | Path,
    *,
    phrases: list[str] | None = None,
    references: dict | None = None,
    detector: str = CONFIG.phrases.detector,
    model_size: str = CONFIG.phrases.model_size,
    device: str = CONFIG.phrases.device,
    compute_type: str = CONFIG.phrases.compute_type,
    language: str = CONFIG.phrases.language,
    initial_prompt: str | None = None,
    min_confidence: float = CONFIG.phrases.min_confidence,
    min_gap_between_markers: float = CONFIG.phrases.min_gap_between_markers,
    max_word_gap: float = CONFIG.phrases.max_word_gap,
    vad_filter: bool = CONFIG.phrases.vad_filter,
    speech_spans: list[Span] | None = None,
    snap_window: float = CONFIG.phrases.snap_window,
    clip_merge_gap: float = CONFIG.phrases.clip_merge_gap,
    clip_pad: float = CONFIG.phrases.clip_pad,
    total_duration: float | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
) -> list[Marker]:
    """Detect known spoken phrases in ``input_path`` and return timestamped markers.

    Pure analysis: reads the file and returns data. Does not modify or write audio.

    Args:
        input_path: Source audio file (any format ffmpeg can decode).
        phrases: Phrase types to look for; defaults to every entry in PHRASE_REGISTRY
            ("takbir", "tasmi", "tahmid", "tasleem").
        references: Optional reference clips/embeddings per phrase. Reserved for the
            query-by-example backend (detector="embeddings"); ignored by the Whisper backend.
        detector: Detection backend. "whisper" (default) is implemented; "embeddings"
            raises NotImplementedError (planned).
        model_size: Whisper model id or size. Default "large-v3" (best general Arabic).
        device: Inference device, e.g. "cpu" or "cuda".
        compute_type: CTranslate2 compute type, e.g. "int8" (CPU) or "float16" (GPU).
        language: Transcription language code; "ar" for Arabic.
        initial_prompt: Decoder bias prompt; defaults to the canonical target phrases.
        min_confidence: Drop markers below this confidence (0..1).
        min_gap_between_markers: De-duplicate same-type hits closer than this (seconds).
        max_word_gap: Maximum gap (seconds) allowed between consecutive words of a single
            phrase; larger gaps prevent distant filler words from being stitched into a
            false match.
        vad_filter: Apply Whisper's built-in VAD filter to skip non-speech regions. Only
            used when ``speech_spans`` is ``None``.
        speech_spans: Fine speech spans for this file (``SpeechMap.spans()``). When
            given, only the clip audio built from them is transcribed and marker edges
            are snapped to them. ``None`` transcribes the whole file.
        snap_window: Snap onsets/ends to a speech-span edge within this many seconds;
            0 disables snapping.
        clip_merge_gap: Speech spans closer than this are merged into one clip.
        clip_pad: Seconds of context added around each clip.
        total_duration: File duration used to clamp padded clips; when unknown only
            the lower bound is clamped.
        ffmpeg_bin: ffmpeg executable used to decode the clip audio.

    Returns:
        Markers ordered by onset time. Empty when ``speech_spans`` is given but empty
        (nothing to transcribe).

    Raises:
        FileNotFoundError: If ``input_path`` does not exist.
        ValueError: If an unknown phrase type is requested.
        NotImplementedError: If ``detector="embeddings"`` (not yet built).
        RuntimeError: If the optional phrase-detection dependencies are not installed.
    """
    if detector == "embeddings":
        raise NotImplementedError(
            "The query-by-example embeddings backend is planned but not yet implemented; "
            "use detector='whisper'."
        )
    if detector != "whisper":
        raise ValueError(f"Unknown detector: {detector!r}")

    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    types = phrases or list(PHRASE_REGISTRY)
    unknown = [t for t in types if t not in PHRASE_REGISTRY]
    if unknown:
        raise ValueError(f"Unknown phrase type(s): {unknown}")

    clips: list[Span] | None = None
    if speech_spans is not None:
        clips = _clips_from_spans(speech_spans, clip_merge_gap, clip_pad, total_duration)
        if not clips:
            return []

    model = _get_model(model_size, device, compute_type)
    words = _transcribe_words(
        model,
        src,
        language=language,
        initial_prompt=initial_prompt or _default_initial_prompt(),
        vad_filter=vad_filter,
        clips=clips,
        ffmpeg_bin=ffmpeg_bin,
    )

    cands: list[tuple[str, str, float, float, float]] = []
    for ptype in types:
        spec = PHRASE_REGISTRY[ptype]
        for start, end, conf in _candidates_for_spec(spec, words, max_word_gap):
            if conf >= min_confidence:
                cands.append((spec.type, spec.label, start, end, conf))

    markers = _dedupe(cands, min_gap_between_markers)
    if speech_spans is not None and snap_window > 0:
        markers = _snap_markers(markers, speech_spans, snap_window)
    return markers
