"""Speech segmentation: Silero VAD probabilities and the spans derived from them.

This is the only module that touches the Silero network. It runs the vendored ONNX
export (``assets/silero_vad.onnx``: Silero's official 16 kHz v6 model, MIT) through
onnxruntime over 512-sample (32 ms) frames at 16 kHz and returns one speech probability
per frame. Everything downstream -- the ``"vad"`` silence detector, Whisper clip scoping
and marker onset snapping in phrase detection -- consumes those probabilities through
:class:`SpeechMap`.

The network is recurrent: each frame is fed together with the last 64 samples of the
previous frame and the LSTM state carried from it, one session call per frame. That is
the same procedure the ``silero_vad`` reference package uses, so the probabilities match
it exactly. The pass is CPU-bound and linear in the audio length; it takes a small
fraction of the recording's own duration, cheap enough to do once at extraction time
but not something to repeat on every detect.

Why probabilities are persisted rather than spans: the network pass is the expensive
part while thresholding is instant. Storing the raw frame probabilities makes the
sidecar threshold-independent, so every consumer re-thresholds with its own knobs (a
live sensitivity slider, a stricter phrase pass) without touching the model again. Only
a model version bump invalidates the file.

Why the fine pass uses ``bridge_gap``: Silero's segmenter glues speech runs separated by
less than its ``min_silence`` into one span. If a consumer's coarse report threshold
(e.g. the 3 s silence knob) were fed in there, a takbir followed 0.8 s later by
recitation would sit in the middle of a span instead of at an edge, and the spans would
be useless for onset snapping. So :meth:`SpeechMap.spans` always bridges with the small
``segmentation.bridge_gap`` and each consumer applies its own coarse rule afterwards
(silence keeps only long gaps; phrases merge spans into clips with ``clip_merge_gap``).

Read-only like the rest of ``detection/``: :meth:`SpeechMap.save` exists so the
extraction layer can persist the sidecar, and it is the only caller. ``onnxruntime`` is
optional (the ``vad`` extra) and imported lazily; the energy-gate silence path and
full-file Whisper never need it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..config import CONFIG
from ._pcm import SAMPLE_RATE, decode_pcm
from ._spans import Span

FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
MODEL_VERSION = "silero-vad-v6"

# The vendored graph is Silero's 16 kHz-only export; its frame size, context length and
# the ``sr`` input it accepts are all fixed to that rate.
_MODEL_SAMPLE_RATE = 16000

_MODEL_PATH = Path(__file__).with_name("assets") / "silero_vad.onnx"

_SESSION = None
# Worker threads (silence and phrase pools) may race to create the first session; a
# second InferenceSession would only waste memory, so creation is serialized.
_SESSION_LOCK = threading.Lock()


def _session():
    """Return the process-wide onnxruntime session for the Silero network (lazy, thread-safe).

    Raises:
        ImportError: If onnxruntime (the ``vad`` extra) is not installed.
        RuntimeError: If the configured working sample rate is not the 16 kHz the
            vendored graph was exported for.
    """
    global _SESSION
    if _SESSION is not None:
        return _SESSION
    with _SESSION_LOCK:
        if _SESSION is not None:
            return _SESSION
        if SAMPLE_RATE != _MODEL_SAMPLE_RATE:
            raise RuntimeError(
                f"The vendored Silero VAD graph only supports {_MODEL_SAMPLE_RATE} Hz audio, "
                f"but audio.working_sample_rate is {SAMPLE_RATE}."
            )
        try:
            import onnxruntime
        except ImportError as err:  # pragma: no cover - exercised only without the extra
            raise ImportError(
                "Speech segmentation requires the optional 'vad' extra "
                '(pip install -e ".[vad]": onnxruntime + numpy).'
            ) from err
        # One thread: each call is a single 576-sample frame, so parallelism inside the
        # graph only adds scheduling overhead. Errors-only logging keeps onnxruntime's
        # graph-cleanup warnings out of the service log.
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.enable_cpu_mem_arena = False
        opts.log_severity_level = 3
        _SESSION = onnxruntime.InferenceSession(
            str(_MODEL_PATH), providers=["CPUExecutionProvider"], sess_options=opts
        )
        return _SESSION


def speech_probs(audio: np.ndarray) -> np.ndarray:
    """Return one Silero speech probability per 512-sample frame of ``audio``.

    ``audio`` is mono float32 at 16 kHz (as produced by ``_pcm.decode_pcm``). The tail is
    zero-padded to a whole frame. Each network input is the frame preceded by the last 64
    samples of the previous frame (zeros for the first) and the LSTM state returned by the
    previous call, so the whole file is one continuous recurrent pass.
    """
    session = _session()
    audio = np.ascontiguousarray(audio, dtype=np.float32).reshape(-1)
    remainder = len(audio) % FRAME_SAMPLES
    if remainder:
        audio = np.concatenate([audio, np.zeros(FRAME_SAMPLES - remainder, dtype=np.float32)])
    if len(audio) == 0:
        return np.zeros(0, dtype=np.float32)

    frames = audio.reshape(-1, FRAME_SAMPLES)
    context = np.roll(frames[:, -CONTEXT_SAMPLES:], 1, axis=0)
    context[0] = 0.0
    # Build every [context | frame] row up front so the loop is only session calls.
    rows = np.ascontiguousarray(np.concatenate([context, frames], axis=1), dtype=np.float32)

    state = np.zeros((2, 1, 128), dtype=np.float32)
    sr = np.array(SAMPLE_RATE, dtype=np.int64)
    probs = np.empty(rows.shape[0], dtype=np.float32)
    for i in range(rows.shape[0]):
        out, state = session.run(None, {"input": rows[i : i + 1], "state": state, "sr": sr})
        probs[i] = out[0, 0]
    return probs


def spans_from_probs(
    probs: np.ndarray,
    *,
    threshold: float,
    min_speech_duration: float,
    min_silence_duration: float,
    speech_pad: float,
    frame_seconds: float = FRAME_SECONDS,
    total: float | None = None,
) -> list[Span]:
    """Turn per-frame speech probabilities into ``(start, end)`` speech spans in seconds.

    Port of Silero's reference segmenter with hysteresis: a span opens when a frame
    reaches ``threshold`` and closes only after probabilities have stayed below
    ``threshold - 0.15`` for ``min_silence_duration``; the span then ends where that
    silence began. Spans shorter than ``min_speech_duration`` are dropped, and a span
    still open at the end of the audio is closed there. Finally each span is widened by
    ``speech_pad``; when two spans are closer than twice the pad the gap is split
    between them instead so they never overlap. There is no maximum span length: a
    ten-minute recitation is one span. Times are exact frame multiples, not rounded.

    ``total`` is the true audio duration used to close and clamp the last span (Silero's
    ``audio_length_samples``). The final frame is zero-padded, so without it spans could
    end up to one frame past the real end of the file; ``None`` falls back to the
    whole-frame length.
    """
    n = len(probs)
    frames_total = n * frame_seconds
    total = frames_total if total is None else min(total, frames_total)
    neg_threshold = max(threshold - 0.15, 0.01)
    min_speech = min_speech_duration
    min_silence = min_silence_duration

    spans: list[list[float]] = []
    triggered = False
    start = 0.0
    temp_end = 0.0

    for i in range(n):
        p = float(probs[i])
        t = i * frame_seconds

        if p >= threshold and temp_end:
            temp_end = 0.0

        if p >= threshold and not triggered:
            triggered = True
            start = t
            continue

        if p < neg_threshold and triggered:
            if not temp_end:
                temp_end = t
            if t - temp_end < min_silence:
                continue
            if temp_end - start > min_speech:
                spans.append([start, temp_end])
            temp_end = 0.0
            triggered = False

    if triggered and total - start > min_speech:
        spans.append([start, total])

    for i, span in enumerate(spans):
        if i == 0:
            span[0] = max(0.0, span[0] - speech_pad)
        if i != len(spans) - 1:
            gap = spans[i + 1][0] - span[1]
            if gap < 2 * speech_pad:
                span[1] += gap / 2
                spans[i + 1][0] = max(0.0, spans[i + 1][0] - gap / 2)
            else:
                span[1] = min(total, span[1] + speech_pad)
                spans[i + 1][0] = max(0.0, spans[i + 1][0] - speech_pad)
        else:
            span[1] = min(total, span[1] + speech_pad)

    return [(float(a), float(b)) for a, b in spans]


@dataclass(frozen=True)
class SpeechMap:
    """Per-frame Silero speech probabilities for one audio source.

    Attributes:
        probs: float32 ``[n_frames]`` speech probabilities in ``[0, 1]``.
        frame_seconds: Duration of one frame (32 ms at 16 kHz).
        n_samples: Number of decoded 16 kHz samples the map covers, before the last
            frame was zero-padded. This is the true audio length; ``len(probs)`` alone
            can only bound it to within one frame.
        model_version: Identifier of the network that produced ``probs``; a mismatch
            with :data:`MODEL_VERSION` means the sidecar should be recomputed.
    """

    probs: np.ndarray
    frame_seconds: float
    n_samples: int
    model_version: str

    @property
    def duration(self) -> float:
        """True covered duration in seconds (from the sample count, not whole frames)."""
        return self.n_samples / SAMPLE_RATE

    def spans(
        self,
        *,
        threshold: float = CONFIG.segmentation.speech_threshold,
        min_speech_duration: float = CONFIG.segmentation.min_speech_duration,
        bridge_gap: float = CONFIG.segmentation.bridge_gap,
        speech_pad: float = CONFIG.segmentation.speech_pad,
    ) -> list[Span]:
        """Fine speech spans: see :func:`spans_from_probs` (``bridge_gap`` is its ``min_silence_duration``).

        Spans are clamped to :attr:`duration`, so no span ends past the real audio.
        """
        return spans_from_probs(
            self.probs,
            threshold=threshold,
            min_speech_duration=min_speech_duration,
            min_silence_duration=bridge_gap,
            speech_pad=speech_pad,
            frame_seconds=self.frame_seconds,
            total=self.duration,
        )

    @classmethod
    def compute(cls, audio_or_path: np.ndarray | str | Path, ffmpeg_bin: str = CONFIG.ffmpeg.bin) -> "SpeechMap":
        """Run the network over a decoded array or an audio file path.

        The onnxruntime session is resolved before anything is decoded, so a missing
        ``vad`` extra surfaces as ``ImportError`` without first paying for an ffmpeg
        decode of the whole file.

        Raises:
            ImportError: If onnxruntime is not installed.
            RuntimeError: If ffmpeg fails to decode ``audio_or_path`` (when a path).
        """
        _session()
        if isinstance(audio_or_path, (str, Path)):
            audio = decode_pcm(audio_or_path, ffmpeg_bin)
        else:
            audio = audio_or_path
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        return cls(
            probs=speech_probs(audio),
            frame_seconds=FRAME_SECONDS,
            n_samples=int(audio.shape[0]),
            model_version=MODEL_VERSION,
        )

    @classmethod
    def load(cls, path: str | Path) -> "SpeechMap":
        """Read a sidecar written by :meth:`save`.

        Every key is required; a file missing one (or unreadable) raises so the caller
        can discard it and recompute rather than run on partial data.
        """
        with np.load(Path(path)) as data:
            return cls(
                probs=np.asarray(data["probs"], dtype=np.float32).reshape(-1),
                frame_seconds=float(data["frame_seconds"]),
                n_samples=int(data["n_samples"]),
                model_version=str(data["model_version"]),
            )

    def save(self, path: str | Path) -> Path:
        """Write the map as an ``.npz`` sidecar.

        The extraction layer (``extraction/segment.py``) is the only caller: detection
        itself never writes files, and keeping the persistence call here (next to
        :meth:`load`) just keeps the on-disk format in one place.

        Raises:
            ValueError: If ``path`` does not end in ``.npz``. ``np.savez`` would silently
                append the suffix, leaving the returned path pointing at nothing.
        """
        dst = Path(path)
        if dst.suffix != ".npz":
            raise ValueError(f"Speech map path must end in .npz: {dst}")
        np.savez(
            dst,
            probs=self.probs.astype(np.float32),
            frame_seconds=np.float64(self.frame_seconds),
            n_samples=np.int64(self.n_samples),
            model_version=np.str_(self.model_version),
        )
        return dst
