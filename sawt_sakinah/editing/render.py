"""Render an :class:`EditDecisionList` to a new audio file (the export step).

This is the general, non-destructive renderer: given the original ``AudioSource`` and an
EDL, it produces a fresh file by applying the EDL's operations via an ffmpeg
``filter_complex`` graph (``atrim`` + ``concat``, with short boundary fades to avoid
clicks). Nothing is mutated in place; the original artifact is untouched.

Operation semantics (see docs/audio/04-editing-and-export.md):

* ``cut``    -- remove ``[start, end]`` from the timeline.
* ``keep``   -- when any ``keep`` op is present, retain only the union of keep spans
                (then any ``cut`` ops are subtracted from that).
* ``fade``   -- apply a short fade over ``[start, end]`` (fade-in if it sits at the very
                start of the output, otherwise fade-out), on top of the automatic
                click-avoidance fades at every cut boundary.
* ``marker`` -- not a mutation; optionally embedded as a chapter on export.

The actual work lives in :func:`_render`, which operates on a plain file path so the
legacy :func:`remove_silence` path can share the exact same engine.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Optional, Sequence

from ..config import CONFIG
from ..ffmpeg import run_ffmpeg
from ..models import AudioSource, EditDecisionList, EditOperation
from ..proc import ffmpeg_input

# Small fade (seconds) applied at every internal cut boundary to avoid clicks/pops when
# concatenating slices that do not start/end on a zero crossing.
DEFAULT_BOUNDARY_FADE = CONFIG.editing.boundary_fade


def render(
    audio_source: AudioSource,
    edl: EditDecisionList,
    out_format: str = CONFIG.editing.out_format,
    out_path: str | Path | None = None,
    *,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
    overwrite: bool = True,
    boundary_fade: float = DEFAULT_BOUNDARY_FADE,
    bitrate: str | None = None,
    vbr_quality: str | None = None,
    embed_markers: bool = CONFIG.editing.embed_markers,
    chapter_markers: Optional[Sequence[tuple[float, str]]] = None,
    embed_metadata: bool = CONFIG.editing.embed_metadata,
) -> Path:
    """Render ``edl`` against ``audio_source`` and write a new audio file.

    Args:
        audio_source: The source the EDL was authored against. Its ``local_path`` is read
            (never modified) and ``duration_sec`` is used as the authoritative length.
        edl: The edit decision list to apply.
        out_format: Output extension/codec (``"mp3"``, ``"wav"``, ...). Used only when
            ``out_path`` is not given (and to pick default quality knobs).
        out_path: Destination file. Defaults to ``<local_path stem>.edited.<out_format>``.
        ffmpeg_bin: Name/path of the ffmpeg executable.
        ffprobe_bin: Name/path of the ffprobe executable, used when the source's
            duration is unknown.
        overwrite: Overwrite ``out_path`` if it already exists.
        boundary_fade: Length in seconds of the automatic fade at each cut boundary.
            ``0`` disables it.
        bitrate: Constant bitrate (e.g. ``"192k"``). Takes precedence over ``vbr_quality``.
        vbr_quality: VBR quality for mp3 (``"0"`` is best). Defaults to ``"0"`` for mp3
            when neither ``bitrate`` nor ``vbr_quality`` is given.
        embed_markers: Embed chapters in the output. Uses ``chapter_markers`` when given,
            else falls back to the EDL's ``marker`` operations.
        chapter_markers: Source-timeline ``(time, label)`` pairs (e.g. the project's
            detected/user markers) to embed as labeled chapters. Times are remapped to the
            output timeline and dropped if they fall inside a cut. ``None`` uses the EDL
            ``marker`` ops instead.
        embed_metadata: Refresh ``title`` and source-URL metadata on the output.

    Returns:
        Path to the rendered file.

    Raises:
        FileNotFoundError: If ffmpeg or the source file is missing.
        ValueError: If the operations cut the entire file (nothing left to keep).
        RuntimeError: If ffmpeg exits with an error or times out.
    """
    src = Path(audio_source.local_path)
    dst = (
        Path(out_path)
        if out_path is not None
        else src.with_name(f"{src.stem}.edited.{out_format}")
    )

    if bitrate is None and vbr_quality is None and out_format == "mp3":
        vbr_quality = CONFIG.editing.mp3_vbr_quality

    metadata = (
        {"title": audio_source.title, "source_url": audio_source.source_url}
        if embed_metadata
        else None
    )

    return _render(
        src,
        audio_source.duration_sec,
        edl.operations,
        dst,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        overwrite=overwrite,
        boundary_fade=boundary_fade,
        bitrate=bitrate,
        vbr_quality=vbr_quality,
        embed_markers=embed_markers,
        chapter_markers=chapter_markers,
        metadata=metadata,
    )


def _render(
    src: Path,
    duration: float,
    operations: Sequence[EditOperation],
    out_path: Path,
    *,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
    overwrite: bool = True,
    boundary_fade: float = 0.0,
    bitrate: str | None = None,
    vbr_quality: str | None = None,
    embed_markers: bool = False,
    chapter_markers: Optional[Sequence[tuple[float, str]]] = None,
    metadata: Optional[dict] = None,
) -> Path:
    """Path-based render engine shared by :func:`render` and ``remove_silence``."""
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")
    if not duration or duration <= 0:
        from ..extraction.probe import probe

        duration = probe(src, ffprobe_bin=ffprobe_bin)["duration_sec"]

    keeps = _resolve_keeps(operations, duration)
    if not keeps:
        raise ValueError("operations cut the entire file; nothing left to keep.")

    fade_ops = [op for op in operations if op.type == "fade" and op.end is not None]
    out_total = sum(b - a for a, b in keeps)

    base = [ffmpeg_bin, "-y" if overwrite else "-n", *ffmpeg_input(src)]

    meta_file: Optional[Path] = None
    if embed_markers:
        chapters = _chapter_lines(operations, keeps, out_total, chapter_markers)
        if chapters:
            meta_file = _write_ffmetadata(chapters)
            base += ffmpeg_input(meta_file)

    cmd = list(base)
    trimming = keeps != [(0.0, duration)]
    graph = _build_graph(keeps, boundary_fade, fade_ops) if (trimming or fade_ops) else None
    if graph is not None:
        cmd += ["-filter_complex", graph[0], "-map", graph[1]]
    else:
        cmd += ["-map", "0:a"]

    if meta_file is not None:
        cmd += ["-map_metadata", "1"]
    if metadata is not None:
        cmd += [
            "-metadata", f"title={metadata.get('title', '')}",
            "-metadata", f"comment=source: {metadata.get('source_url', '')}",
        ]

    if bitrate is not None:
        cmd += ["-b:a", bitrate]
    elif vbr_quality is not None:
        cmd += ["-q:a", str(vbr_quality)]

    cmd += [str(out_path)]

    try:
        proc = run_ffmpeg(cmd)
    finally:
        if meta_file is not None:
            meta_file.unlink(missing_ok=True)

    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg render failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return out_path


def _span(op: EditOperation, duration: float) -> tuple[float, float]:
    end = op.end if op.end is not None else duration
    return (max(0.0, op.start), min(duration, end))


def _merge_overlaps(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping/adjacent spans (input need not be sorted)."""
    merged: list[tuple[float, float]] = []
    for a, b in sorted(spans):
        if b <= a:
            continue
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def _subtract(base: list[tuple[float, float]], cuts: list[tuple[float, float]]):
    """Remove ``cuts`` from ``base`` (both sorted, non-overlapping)."""
    result: list[tuple[float, float]] = []
    for a, b in base:
        cursor = a
        for cs, ce in cuts:
            if ce <= cursor or cs >= b:
                continue
            if cs > cursor:
                result.append((cursor, cs))
            cursor = max(cursor, ce)
            if cursor >= b:
                break
        if cursor < b:
            result.append((cursor, b))
    return result


def _resolve_keeps(
    operations: Sequence[EditOperation], duration: float
) -> list[tuple[float, float]]:
    """Compute the kept spans (the complement that survives) from the EDL operations."""
    keep_ops = [op for op in operations if op.type == "keep"]
    cut_ops = [op for op in operations if op.type == "cut"]

    if keep_ops:
        base = _merge_overlaps([_span(op, duration) for op in keep_ops])
    else:
        base = [(0.0, duration)]

    cuts = _merge_overlaps([_span(op, duration) for op in cut_ops])
    return _subtract(base, cuts)


def _remap_time(t: float, keeps: list[tuple[float, float]]) -> Optional[float]:
    """Map a source-timeline time to the output timeline, or ``None`` if it was cut."""
    offset = 0.0
    for a, b in keeps:
        if t < a:
            return None
        if t <= b:
            return offset + (t - a)
        offset += b - a
    return None


def _build_graph(
    keeps: list[tuple[float, float]],
    boundary_fade: float,
    fade_ops: Sequence[EditOperation],
) -> tuple[str, str]:
    """Build a ``filter_complex`` graph keeping ``keeps`` and return ``(graph, label)``."""
    last = keeps[-1][1]
    parts: list[str] = []
    for i, (a, b) in enumerate(keeps):
        seg = b - a
        chain = f"[0:a]atrim={a}:{b},asetpts=N/SR/TB"
        if boundary_fade > 0 and seg > 2 * boundary_fade:
            # a > 0 / b < last imply an adjacent cut, so fade to avoid a click there.
            if a > 0:
                chain += f",afade=t=in:st=0:d={boundary_fade}"
            if b < last:
                chain += f",afade=t=out:st={seg - boundary_fade}:d={boundary_fade}"
        parts.append(f"{chain}[k{i}]")

    labels = "".join(f"[k{i}]" for i in range(len(keeps)))
    parts.append(f"{labels}concat=n={len(keeps)}:v=0:a=1[cc]")

    label = "[cc]"
    for j, op in enumerate(fade_ops):
        start = _remap_time(op.start, keeps)
        if start is None:
            continue
        d = max(0.0, (op.end - op.start))
        if d <= 0:
            continue
        nxt = f"[f{j}]"
        if start <= 1e-3:
            parts.append(f"{label}afade=t=in:st=0:d={d}{nxt}")
        else:
            parts.append(f"{label}afade=t=out:st={start}:d={d}{nxt}")
        label = nxt

    return ";".join(parts), label


def _chapter_lines(
    operations: Sequence[EditOperation],
    keeps: list[tuple[float, float]],
    out_total: float,
    chapter_markers: Optional[Sequence[tuple[float, str]]] = None,
) -> list[tuple[float, float, str]]:
    """Build ``(start, end, title)`` chapters on the output timeline.

    When ``chapter_markers`` (source-timeline ``(time, label)`` pairs, e.g. detected /
    user markers) is given, chapters carry those real labels. Otherwise they fall back to
    the EDL's ``marker`` ops with generic titles. Times are remapped to the output
    timeline; any that fall inside a cut region are dropped. Each chapter runs until the
    next one (the last until ``out_total``).
    """
    if chapter_markers is not None:
        labeled: list[tuple[float, str]] = []
        for time, label in chapter_markers:
            t = _remap_time(time, keeps)
            if t is not None:
                labeled.append((t, label))
        labeled.sort(key=lambda e: e[0])
        chapters: list[tuple[float, float, str]] = []
        for i, (t, label) in enumerate(labeled):
            end = labeled[i + 1][0] if i + 1 < len(labeled) else out_total
            chapters.append((t, end, label))
        return chapters

    times: list[float] = []
    for op in operations:
        if op.type != "marker":
            continue
        t = _remap_time(op.start, keeps)
        if t is not None:
            times.append(t)
    times.sort()
    chapters = []
    for i, t in enumerate(times):
        end = times[i + 1] if i + 1 < len(times) else out_total
        chapters.append((t, end, f"Marker {i + 1}"))
    return chapters


def _escape_ffmetadata(value: str) -> str:
    """Escape ffmetadata syntax (``= ; # \\``) and fold line breaks into spaces."""
    value = " ".join(value.splitlines())
    for ch in ("\\", "=", ";", "#"):
        value = value.replace(ch, "\\" + ch)
    return value


def _write_ffmetadata(chapters: list[tuple[float, float, str]]) -> Path:
    """Write an ffmetadata file describing ``chapters`` and return its path."""
    lines = [";FFMETADATA1"]
    for start, end, title in chapters:
        lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={int(round(start * 1000))}",
            f"END={int(round(end * 1000))}",
            f"title={_escape_ffmetadata(title)}",
        ]
    fd, name = tempfile.mkstemp(suffix=".ffmeta", text=True)
    path = Path(name)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path
