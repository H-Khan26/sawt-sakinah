"""Spoken-phrase detection (Arabic takbir and recurring utterances).

Finds occurrences of known prayer phrases -- the takbir ("Allahu Akbar") that announces
every position transition, plus tasmi'/tahmid/tasleem -- and returns timestamped
``Marker``s. Pure analysis: reads the audio and returns data, never mutates or writes.
The ordered marker stream feeds the prayer state machine and the waveform UI. See
docs/audio/03-phrase-detection.md.

Baseline backend (``detector="whisper"``): transcribe with an Arabic Whisper model and
word-level timestamps, biasing the decoder toward the target phrases via the initial
prompt, then fuzzy-match each phrase against the normalized word stream. Word onsets are
coarse (~+-0.5 s) but adequate as a first pass; sharper, reciter-specific onsets are a
later job for the query-by-example backend (``detector="embeddings"``, not yet built).

The model dependencies (``faster-whisper`` + ``rapidfuzz``) are optional; install them
with the project's ``phrases`` extra (see requirements-phrases.txt). They are imported
lazily so the rest of the package never needs them.
"""

from __future__ import annotations

from pathlib import Path

from ..models import Marker
from ._arabic import PHRASE_REGISTRY, PhraseSpec, normalize_arabic

# Cache loaded Whisper models across calls, keyed by (model_size, device, compute_type).
# Loading large-v3 is expensive; detect_phrases stays read-only otherwise.
_MODEL_CACHE: dict[tuple[str, str, str], object] = {}

# Confidence blend and gating thresholds (0..100 for RapidFuzz scores). Tuned on real
# clips during prototyping; exposed indirectly through min_confidence.
_KEYWORD_GATE = 78.0          # each required keyword must partial-match at least this
_FUZZY_FLOOR = 60.0           # whole-phrase token_sort_ratio floor before scoring
_FUZZY_WEIGHT = 0.6           # confidence = _FUZZY_WEIGHT*fuzzy + (1-_FUZZY_WEIGHT)*prob


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
                "(pip install -r requirements-phrases.txt: faster-whisper + rapidfuzz)."
            ) from err
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _MODEL_CACHE[key] = model
    return model


def _transcribe_words(
    model,
    input_path: Path,
    language: str,
    initial_prompt: str,
    vad_filter: bool,
) -> list[tuple[str, float, float, float]]:
    """Return a flat word stream as (normalized_text, start, end, probability)."""
    segments, _info = model.transcribe(
        str(input_path),
        language=language,
        word_timestamps=True,
        initial_prompt=initial_prompt,
        vad_filter=vad_filter,
    )
    words: list[tuple[str, float, float, float]] = []
    for seg in segments:
        for w in seg.words or []:
            norm = normalize_arabic(w.word.strip())
            if not norm:
                continue
            prob = float(getattr(w, "probability", None) or 0.0)
            words.append((norm, float(w.start), float(w.end), prob))
    return words


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
    detector: str = "whisper",
    model_size: str = "large-v3",
    device: str = "cpu",
    compute_type: str = "int8",
    language: str = "ar",
    initial_prompt: str | None = None,
    min_confidence: float = 0.4,
    min_gap_between_markers: float = 1.0,
    max_word_gap: float = 1.0,
    vad_filter: bool = True,
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
            raises NotImplementedError (planned Phase 2).
        model_size: Whisper model id or size. Default "large-v3" (best general Arabic).
            A Quran-tuned id (e.g. "tarteel-ai/whisper-base-ar-quran") is a drop-in.
        device: Inference device, e.g. "cpu" or "cuda".
        compute_type: CTranslate2 compute type, e.g. "int8" (CPU) or "float16" (GPU).
        language: Transcription language code; "ar" for Arabic.
        initial_prompt: Decoder bias prompt; defaults to the canonical target phrases.
        min_confidence: Drop markers below this confidence (0..1).
        min_gap_between_markers: De-duplicate same-type hits closer than this (seconds).
        max_word_gap: Maximum gap (seconds) allowed between consecutive words of a single
            phrase; larger gaps prevent distant filler words from being stitched into a
            false match.
        vad_filter: Apply Whisper's built-in VAD filter to skip non-speech regions.

    Returns:
        Markers ordered by onset time.

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

    model = _get_model(model_size, device, compute_type)
    words = _transcribe_words(
        model,
        src,
        language=language,
        initial_prompt=initial_prompt or _default_initial_prompt(),
        vad_filter=vad_filter,
    )

    cands: list[tuple[str, str, float, float, float]] = []
    for ptype in types:
        spec = PHRASE_REGISTRY[ptype]
        for start, end, conf in _candidates_for_spec(spec, words, max_word_gap):
            if conf >= min_confidence:
                cands.append((spec.type, spec.label, start, end, conf))

    return _dedupe(cands, min_gap_between_markers)
