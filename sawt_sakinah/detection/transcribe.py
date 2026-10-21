"""Speech-to-text with word timestamps on the source timeline (Whisper, CTranslate2).

Transcribes a recording with a ``whisper_models`` catalog model and returns a flat word
stream, each word normalized for matching (``_arabic.arabic_words``) and timed in source
seconds. Pure analysis: reads the audio and returns data, never writes audio. The surah
matcher (``surahs.py``) consumes the words. See docs/audio/03-surah-recognition.md.

When the caller supplies the source's fine speech spans (from ``segmentation.py``) the
spans are grouped into padded clips, the clip audio is concatenated and transcribed as one
stream with Whisper's own VAD disabled, and word times are mapped back to source time
through the clip offsets. Concatenating (rather than handing Whisper per-clip
``clip_timestamps``) matters for cost: the encoder always processes 30 s windows, so
isolated short clips would each pay for a full window, while one packed stream is decoded
in as few windows as the speech itself needs. Without spans (no speech map available) the
whole file is transcribed with Whisper's built-in VAD.

No initial prompt is given: the model is a Quran fine-tune and transcribes recitation as
it is. A finished transcription can be kept as a JSON sidecar (:func:`save_transcript` /
:func:`load_transcript`) so matching can run again without transcribing.

The model dependencies (``faster-whisper`` + ``rapidfuzz``) are optional; install them
with the project's ``transcription`` extra (``pip install -e ".[transcription]"``). They
are imported lazily so the rest of the package never needs them.
"""

from __future__ import annotations

import json
import os
from bisect import bisect_right
from pathlib import Path
from typing import Callable, NamedTuple, Optional

from ..config import CONFIG
from ..fileio import replace_file
from . import whisper_models
from ._arabic import arabic_words
from ._pcm import SAMPLE_RATE, decode_pcm
from ._spans import Span, merge_within_gap, pad_spans

ProgressFn = Callable[[dict], None]

# Cache the loaded Whisper model across calls, keyed by (model directory, device,
# compute_type). Loading is expensive; only the most recent model is kept.
_MODEL_CACHE: dict[tuple[str, str, str], object] = {}


class Word(NamedTuple):
    """One transcribed word on the source timeline.

    Attributes:
        text: Normalized bare-letter form used for matching (see ``arabic_words``).
        start: Onset in source seconds.
        end: Offset in source seconds.
        probability: Whisper's word probability (0..1).
        raw: The word as Whisper wrote it (diacritised).
    """

    text: str
    start: float
    end: float
    probability: float
    raw: str


def _model_dir(model: str, models_dir: str | os.PathLike | None) -> Path:
    """Local directory for ``model``: a catalog id's directory (installed or not) or a
    directory holding a CTranslate2 Whisper model."""
    if model in whisper_models.catalog():
        return whisper_models.model_dir(model, models_dir)
    path = Path(model)
    if path.is_dir():
        return path
    raise whisper_models.UnknownModelError(
        f"Unknown Whisper model {model!r}; expected one of: "
        f"{', '.join(whisper_models.catalog())}"
    )


def _get_model(model_path: Path, device: str, compute_type: str):
    key = (os.path.normcase(os.path.abspath(model_path)), device, compute_type)
    model = _MODEL_CACHE.get(key)
    if model is None:
        whisper_models.configure_hf_env()
        try:
            from faster_whisper import WhisperModel
        except ImportError as err:  # pragma: no cover - exercised only without the extra
            raise RuntimeError(
                "Transcription requires the optional 'transcription' extra "
                '(pip install -e ".[transcription]": faster-whisper + rapidfuzz).'
            ) from err
        _MODEL_CACHE.clear()
        # A directory plus local_files_only: faster-whisper never contacts the Hub.
        model = WhisperModel(
            str(model_path), device=device, compute_type=compute_type, local_files_only=True
        )
        _MODEL_CACHE[key] = model
    return model


def evict_model(model_path: str | os.PathLike) -> None:
    """Drop any cached model loaded from ``model_path`` (before deleting its files)."""
    prefix = os.path.normcase(os.path.abspath(model_path))
    for key in [k for k in _MODEL_CACHE if k[0] == prefix]:
        _MODEL_CACHE.pop(key, None)


# One entry per concatenated clip: (start in the packed stream, source start, source end).
_ClipOffset = tuple[float, float, float]


def _clip_groups(clips: list[Span], window_reset: float) -> list[list[Span]]:
    """Split ``clips`` into the groups Whisper decodes as separate streams: a clip at
    least ``window_reset`` seconds long (a recitation, not a takbir) opens a new group, so
    it begins at the start of a window instead of partway through one that opened on
    earlier clips. ``window_reset`` 0 keeps every clip in one group."""
    groups: list[list[Span]] = []
    for clip in clips:
        if not groups or (window_reset and clip[1] - clip[0] >= window_reset):
            groups.append([clip])
        else:
            groups[-1].append(clip)
    return groups


def _pack_clips(audio, clips: list[Span], gap: float = 0.0) -> tuple[object, list[_ClipOffset]]:
    """Concatenate the ``clips`` of the decoded 16 kHz ``audio`` into one float32 stream,
    with ``gap`` seconds of silence between them.

    Returns the packed audio plus the offset table needed to map packed-stream times
    back to source time. Clips are ordered and non-overlapping (see ``_clips_from_spans``)
    so the packed stream preserves source order.
    """
    import numpy as np

    pieces = []
    offsets: list[_ClipOffset] = []
    packed_start = 0.0
    silence = np.zeros(int(round(gap * SAMPLE_RATE)), dtype=np.float32)
    for start, end in clips:
        a = min(len(audio), max(0, int(round(start * SAMPLE_RATE))))
        b = min(len(audio), max(a, int(round(end * SAMPLE_RATE))))
        if b <= a:
            continue
        if pieces and len(silence):
            pieces.append(silence)
            packed_start += len(silence) / SAMPLE_RATE
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
    beam_size: int,
    vad_filter: bool,
    clips: list[Span] | None,
    ffmpeg_bin: str,
    clip_gap: float = 0.0,
    condition_on_previous_text: bool = True,
    window_reset: float = 0.0,
    progress: Optional[ProgressFn] = None,
) -> list[Word]:
    """Return a flat word stream in source time.

    With ``clips`` the clip audio is packed into one stream per clip group (see
    ``_clip_groups``) and Whisper's built-in VAD is bypassed (the clips already are the
    speech); without them the whole file is handed to Whisper with ``vad_filter`` as
    configured. ``progress`` receives ``{"stage": "transcribing", "done_sec",
    "total_sec"}`` as each segment is decoded, both in seconds of the audio handed to
    Whisper (the packed clips, or the file). A Whisper word holding several normalized
    words is split into words sharing its times; one with no Arabic letters left is
    dropped.
    """
    words: list[Word] = []
    total = 0.0

    def report(done: float) -> None:
        if progress is not None:
            progress(
                {
                    "stage": "transcribing",
                    "done_sec": round(min(max(done, 0.0), total), 2),
                    "total_sec": round(total, 2),
                }
            )

    def consume(segments, offsets: list[_ClipOffset] | None, base: float) -> None:
        # The segment generator is lazy: each segment is decoded as it is consumed.
        for seg in segments:
            for w in seg.words or []:
                raw = w.word.strip()
                prob = float(getattr(w, "probability", None) or 0.0)
                start, end = float(w.start), float(w.end)
                if offsets is not None:
                    start, end = _to_source_time(offsets, start, end)
                for text in arabic_words(raw):
                    words.append(Word(text, start, end, prob, raw))
            report(base + float(seg.end))

    options = dict(
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        condition_on_previous_text=condition_on_previous_text,
    )
    if clips is None:
        segments, info = model.transcribe(str(input_path), vad_filter=vad_filter, **options)
        total = float(info.duration)
        report(0.0)
        consume(segments, None, 0.0)
    else:
        audio = decode_pcm(input_path, ffmpeg_bin)
        packed = [_pack_clips(audio, group, clip_gap) for group in _clip_groups(clips, window_reset)]
        del audio
        packed = [(stream, offsets) for stream, offsets in packed if offsets]
        if not packed:
            return []
        total = sum(len(stream) for stream, _ in packed) / SAMPLE_RATE
        report(0.0)
        done = 0.0
        for stream, offsets in packed:
            segments, _ = model.transcribe(stream, vad_filter=False, **options)
            consume(segments, offsets, done)
            done += len(stream) / SAMPLE_RATE
    report(total)
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


def transcribe(
    input_path: str | Path,
    *,
    model: str = CONFIG.surahs.model,
    device: str = CONFIG.transcription.device,
    compute_type: str = CONFIG.transcription.compute_type,
    language: str = CONFIG.transcription.language,
    beam_size: int = CONFIG.transcription.beam_size,
    vad_filter: bool = CONFIG.transcription.vad_filter,
    speech_spans: list[Span] | None = None,
    clip_merge_gap: float = CONFIG.transcription.clip_merge_gap,
    clip_pad: float = CONFIG.transcription.clip_pad,
    clip_gap: float = CONFIG.transcription.clip_gap,
    condition_on_previous_text: bool = CONFIG.transcription.condition_on_previous_text,
    window_reset: float = CONFIG.transcription.window_reset,
    total_duration: float | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    models_dir: str | os.PathLike | None = None,
    progress: Optional[ProgressFn] = None,
) -> list[Word]:
    """Transcribe ``input_path`` and return its words with source-time timestamps.

    Pure analysis: reads the file and returns data. Does not modify or write audio.

    Args:
        input_path: Source audio file (any format ffmpeg can decode).
        model: A ``whisper_models`` catalog id (loaded from its installed directory under
            ``models_dir``) or the path of a directory holding a CTranslate2 Whisper
            model. Never downloaded here; see ``whisper_models.download``.
        device: Inference device, e.g. "cpu".
        compute_type: CTranslate2 compute type, e.g. "int8".
        language: Transcription language code; "ar" for Arabic.
        beam_size: Beam search width; 1 decodes greedily.
        vad_filter: Apply Whisper's built-in VAD filter to skip non-speech regions. Only
            used when ``speech_spans`` is ``None``.
        speech_spans: Fine speech spans for this file (``SpeechMap.spans()``). When
            given, only the clip audio built from them is transcribed. ``None``
            transcribes the whole file.
        clip_merge_gap: Speech spans closer than this are merged into one clip.
        clip_pad: Seconds of context added around each clip.
        clip_gap: Seconds of silence placed between the packed clips.
        condition_on_previous_text: Whether Whisper sees the previous window's text while
            decoding the next.
        window_reset: A clip at least this long is decoded from the start of a fresh
            window (``_clip_groups``); 0 packs every clip into one stream.
        total_duration: File duration used to clamp padded clips; when unknown only
            the lower bound is clamped.
        ffmpeg_bin: ffmpeg executable used to decode the clip audio.
        models_dir: Root holding the installed catalog models; defaults to
            ``runtime.models_dir()``.
        progress: Receives ``{"stage": "transcribing", "done_sec", "total_sec"}`` as the
            transcription advances (seconds of the audio handed to Whisper).

    Returns:
        Words in source order. Empty when ``speech_spans`` is given but empty.

    Raises:
        FileNotFoundError: If ``input_path`` does not exist.
        RuntimeError: If the optional transcription dependencies are not installed.
        whisper_models.UnknownModelError: If ``model`` is neither a catalog id nor a
            model directory.
        whisper_models.ModelNotInstalledError: If the catalog model isn't downloaded.
    """
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    clips: list[Span] | None = None
    if speech_spans is not None:
        clips = _clips_from_spans(speech_spans, clip_merge_gap, clip_pad, total_duration)
        if not clips:
            return []

    model_path = _model_dir(model, models_dir)
    # Marked in use before the install check, so a delete can't slip in between.
    with whisper_models.in_use(model_path):
        if model in whisper_models.catalog():
            whisper_models.installed_path(model, models_dir)
        whisper = _get_model(model_path, device, compute_type)
        return _transcribe_words(
            whisper,
            src,
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            clips=clips,
            ffmpeg_bin=ffmpeg_bin,
            clip_gap=clip_gap,
            condition_on_previous_text=condition_on_previous_text,
            window_reset=window_reset,
            progress=progress,
        )


def save_transcript(path: str | Path, model: str, words: list[Word]) -> Path:
    """Write ``{"model": model, "words": [[text, start, end, probability, raw], ...]}``
    to ``path`` atomically and return it."""
    dst = Path(path)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    data = {"model": model, "words": [list(w) for w in words]}
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    replace_file(tmp, dst)
    return dst


def load_transcript(path: str | Path) -> tuple[str, list[Word]]:
    """Read a sidecar written by :func:`save_transcript`; returns ``(model, words)``.

    Raises ``OSError`` when it can't be read and ``ValueError`` when it is malformed.
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    try:
        model = data["model"]
        words = [
            Word(str(t), float(s), float(e), float(p), str(r)) for t, s, e, p, r in data["words"]
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"malformed transcript sidecar: {exc}") from exc
    if not isinstance(model, str):
        raise ValueError("malformed transcript sidecar: model is not a string")
    return model, words


__all__ = ["Word", "transcribe", "evict_model", "save_transcript", "load_transcript"]
