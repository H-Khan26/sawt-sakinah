"""Extract audio from a link to one post (YouTube, Instagram, X, Facebook) as an MP3 and
describe it as an AudioSource.

Side-effecting layer: network + filesystem. It downloads, transcodes, probes, and
hands back an :class:`AudioSource`. It performs no analysis or editing.

The import runs in stages, each with its own errors: match the link (:mod:`.links`),
resolve a share link, check the platform against the active yt-dlp (:mod:`.compat`),
fetch the metadata, pick one media item and check the limits, download and convert,
then probe and finish (:mod:`.finalize`). yt-dlp's failures are mapped to typed errors
by :mod:`.classify`.

Optional sign-in cookies come from a browser profile or a cookies.txt file. The file is
read into memory and handed to yt-dlp as a stream, so yt-dlp's habit of writing the cookie
jar back on exit never touches the user's file.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import logging
import os
import re
from pathlib import Path
from typing import Callable, Optional

from .. import runtime
from ..config import CONFIG
from ..models.errors import (
    CookiesError,
    ExtractionError,
    ExtractorOutdatedError,
    FileTooLargeError,
    LiveStreamError,
    NoAudioStreamError,
    UnsupportedLinkError,
)
from ..models.sources import AudioSource
from ..ytdlp_updates import import_yt_dlp
from . import cache as _cache
from . import compat
from .classify import classify, is_ytdlp_failure
from .finalize import emit as _emit
from .finalize import finalize_source
from .links import (
    ResolvedLink,
    is_share_link,
    match_link,
    parse_link,
    platform_for_url,
    resolve_link,
)
from .platforms import Platform

_log = logging.getLogger(__name__)

#: Output stem for downloads. A fixed short name keeps paths under Windows' 260-character
#: limit however long the title is; the title itself lives on the AudioSource.
DEFAULT_STEM = "source"

# A cookies.txt larger than this is not one.
_MAX_COOKIES_BYTES = 5 * 1024 * 1024

# How many redirects between extractors (a reel URL handing over to the video extractor)
# the metadata stage follows.
_MAX_HOPS = 3

# Fields of a multi-media post that each picked item inherits, as yt-dlp's playlist
# processing would hand them down.
_PARENT_FIELDS = (
    "extractor",
    "extractor_key",
    "webpage_url",
    "webpage_url_basename",
    "webpage_url_domain",
    "original_url",
)


def _make_download_hook(callback: Callable[[dict], None]) -> Callable[[dict], None]:
    """Adapt yt-dlp's raw progress dict to a normalized
    ``{stage, percent, downloaded_bytes, total_bytes, eta}``."""

    def hook(d: dict) -> None:
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        downloaded = d.get("downloaded_bytes")
        percent = (downloaded / total * 100.0) if total and downloaded else None
        _emit(
            callback,
            stage="download",
            status=d.get("status"),
            percent=percent,
            downloaded_bytes=downloaded,
            total_bytes=total,
            eta=d.get("eta"),
        )

    return hook


def _make_postprocessor_hook(callback: Callable[[dict], None]) -> Callable[[dict], None]:
    """Report yt-dlp's post-processing (the transcode) as ``{stage: transcode, status}``."""

    def hook(d: dict) -> None:
        _emit(callback, stage="transcode", status=d.get("status"))

    return hook


class _YtdlpLogger:
    """Routes yt-dlp's console output to :mod:`logging` (a windowed build has no console)."""

    def debug(self, msg: str) -> None:
        _log.debug("%s", msg)

    def info(self, msg: str) -> None:
        _log.debug("%s", msg)

    def warning(self, msg: str) -> None:
        _log.warning("%s", msg)

    def error(self, msg: str) -> None:
        _log.error("%s", msg)


def _js_runtimes() -> Optional[dict]:
    """yt-dlp ``js_runtimes`` pointing at the bundled (or, from source, PATH) Deno.

    Returns ``None`` to keep yt-dlp's default lookup in a source checkout without Deno,
    and an empty dict in the bundle so a missing copy never falls back to ``PATH``.
    """
    try:
        return {"deno": {"path": runtime.tool_path("deno")}}
    except runtime.ToolNotFoundError:
        if runtime.FROZEN:
            _log.warning("bundled Deno is missing; YouTube extraction may fail")
            return {}
        return None


def _read_cookies_file(path: str | os.PathLike) -> str:
    """The text of a cookies.txt file, read once; raises :class:`CookiesError`."""
    try:
        if os.path.getsize(path) > _MAX_COOKIES_BYTES:
            raise CookiesError(
                "The cookies file chosen in Settings is too large to be a cookies.txt file."
            )
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except FileNotFoundError as exc:
        raise CookiesError(
            f"The cookies file chosen in Settings no longer exists ({path}). Choose it "
            "again in Settings, or turn sign-in cookies off."
        ) from exc
    except OSError as exc:
        raise CookiesError(
            f"Couldn't open the cookies file chosen in Settings ({exc.strerror or exc})."
        ) from exc


def _expected_size(info: dict) -> Optional[int]:
    """Reported byte size of the selected format(s), or ``None`` when unknown."""
    total = 0
    for fmt in info.get("requested_formats") or [info]:
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        if not size:
            return None
        total += int(size)
    return total


def _clock(seconds: float) -> str:
    """``h:mm:ss`` for a duration in seconds."""
    hours, rest = divmod(int(round(seconds)), 3600)
    return f"{hours}:{rest // 60:02d}:{rest % 60:02d}"


def _check_limits(info: dict, max_download_mb: int, max_duration_sec: float) -> None:
    """Reject live streams, over-long videos and oversized streams before downloading."""
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise LiveStreamError("Live streams can't be imported. Try again after it ends.")
    duration = info.get("duration")
    if duration and duration > max_duration_sec:
        raise FileTooLargeError(
            f"This video is {_clock(duration)} long; the limit is {_clock(max_duration_sec)}."
        )
    size = _expected_size(info)
    if size and size > max_download_mb * 1024 * 1024:
        raise FileTooLargeError(
            f"This video's audio is about {size / (1024 * 1024):.0f} MB; the limit is "
            f"{max_download_mb} MB."
        )


def _no_audio(platform: Platform) -> NoAudioStreamError:
    return NoAudioStreamError(
        f"This {platform.item} has no video or audio to import.", platform=platform.id
    )


def _check_has_audio(info: dict, platform: Platform) -> None:
    """Reject media whose selected formats all declare no audio (``acodec == "none"``)."""
    formats = info.get("requested_formats") or [info]
    if all(fmt.get("acodec") == "none" for fmt in formats):
        raise _no_audio(platform)


def _may_have_audio(entry: dict) -> Optional[bool]:
    """Whether a post's media item can carry audio: ``False`` for a photo or a video that
    declares none, ``None`` when it is only a link to resolve."""
    if entry.get("_type") in ("url", "url_transparent"):
        return None
    formats = entry.get("formats") or ([entry] if entry.get("url") else [])
    if not formats:
        return False
    return any(fmt.get("acodec") != "none" for fmt in formats)


def pick_media(info: dict, link: ResolvedLink) -> dict:
    """Reduce a post with several media items to the one to import.

    A single item is returned as is. From a carousel or a multi-video post (a playlist
    result), the first item that can carry audio is taken; its title gains
    ``" (video 2 of 3)"`` (counting videos, not photos) and it inherits the post's
    extractor and page fields. An X link ending ``/video/N`` already names one item.

    Raises:
        NoAudioStreamError: If no item can carry audio.
    """
    if info.get("_type") not in ("playlist", "multi_video"):
        return info
    entries = [e for e in info.get("entries") or [] if isinstance(e, dict)]
    videos = [e for e in entries if _may_have_audio(e) is not False or e.get("formats")]
    chosen = next((e for e in videos if _may_have_audio(e) is not False), None)
    if chosen is None:
        raise _no_audio(link.platform)
    title = chosen.get("title") or info.get("title") or link.post_id
    if len(videos) > 1:
        position = videos.index(chosen) + 1
        # X already numbers its videos ("… #1"); the suffix below says the same.
        title = re.sub(rf" #{position}$", "", title)
        title = f"{title} (video {position} of {len(videos)})"
    if _may_have_audio(chosen) is None:
        # Resolved by its own extractor; transparent so the title still applies.
        return {**chosen, "_type": "url_transparent", "title": title}
    entry = dict(chosen)
    for field in _PARENT_FIELDS:
        if info.get(field) is not None:
            entry.setdefault(field, info[field])
    entry.setdefault("playlist", info.get("title") or info.get("id"))
    entry.setdefault("playlist_id", info.get("id"))
    entry["title"] = title
    return entry


def _fetch_metadata(ydl, link: ResolvedLink) -> dict:
    """The post's unprocessed metadata, following hand-overs between extractors.

    Processing is left to the caller so a post with several items can be reduced to one
    first: processing them all fails on the first photo of a carousel.
    """
    info = ydl.extract_info(link.url, download=False, process=False)
    for _ in range(_MAX_HOPS):
        kind = info.get("_type") if info else None
        if kind not in ("url", "url_transparent"):
            break
        inner = ydl.extract_info(
            info["url"], download=False, process=False, ie_key=info.get("ie_key")
        )
        if kind == "url_transparent" and inner:
            # As yt-dlp merges it: the outer result's fields win, except what names the media.
            exempt = {"_type", "url", "ie_key", "id", "extractor", "extractor_key"}
            outer = {k: v for k, v in info.items() if v is not None and k not in exempt}
            inner = {**inner, **outer}
        info = inner
    if not info or info.get("_type") in ("url", "url_transparent"):
        raise ExtractorOutdatedError(
            f"{link.platform.label} didn't return this {link.platform.item}. "
            "Check for an update.",
            platform=link.platform.id,
        )
    return info


def _source_id(source_key: str, audio_format: str, audio_quality: str) -> str:
    """Deterministic short id for an extraction request (for caching/reference)."""
    key = f"{source_key}|{audio_format}|{audio_quality}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def extract_audio(
    url: str,
    output_dir: str | os.PathLike = ".",
    filename: str | None = None,
    audio_format: str = CONFIG.extraction.audio_format,
    audio_quality: str = CONFIG.extraction.audio_quality,
    quiet: bool = CONFIG.extraction.quiet,
    progress_callback: Optional[Callable[[dict], None]] = None,
    create_working_copy: bool = CONFIG.extraction.create_working_copy,
    normalize_loudness: bool = CONFIG.extraction.normalize_loudness,
    use_cache: bool = CONFIG.extraction.use_cache,
    cache_dir: str | os.PathLike | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
    max_download_mb: int = CONFIG.extraction.max_download_mb,
    max_duration_sec: float = CONFIG.extraction.max_duration_sec,
    cookies_from_browser: Optional[str] = None,
    cookies_file: str | os.PathLike | None = None,
) -> AudioSource:
    """Download the best audio stream for the post ``url`` links to and return an
    :class:`AudioSource`.

    Goes straight from the link to an audio file -- no separate video download step --
    then probes the result for authoritative metadata. The post's metadata is fetched
    first so live streams, over-long videos, oversized streams and media without audio
    are rejected before anything is downloaded.

    Args:
        url: A link to one post on a supported platform (see :mod:`.platforms`), or a
            bare 11-char YouTube video id.
        output_dir: Directory to write the audio file into (created if missing).
        filename: Output filename without extension. Defaults to :data:`DEFAULT_STEM`;
            the title is kept on the returned source, not in the path.
        audio_format: Target audio format passed to FFmpeg (default ``mp3``).
        audio_quality: FFmpeg audio quality. ``"0"`` is best VBR; or a bitrate
            like ``"192K"``.
        quiet: Suppress yt-dlp console output.
        progress_callback: Optional callable invoked during work with a normalized
            payload ``{stage, ...}`` where ``stage`` is one of ``"cache"``,
            ``"metadata"``, ``"download"``, ``"transcode"``, ``"probe"``,
            ``"normalize"``, ``"segment"``, ``"save"``, ``"done"``. Framework-agnostic
            by design.
        create_working_copy: When true, also produce a 16 kHz mono WAV working copy
            and record it on ``AudioSource.working_copy`` for the detection layer.
        normalize_loudness: Apply EBU R128 ``loudnorm`` to the working copy (see
            :func:`make_working_copy`). Ignored when ``create_working_copy`` is false.
        use_cache: When true, return a prior :class:`AudioSource` for the same
            post+format+quality without re-downloading, and persist new extractions.
        cache_dir: Cache root. Defaults to :func:`cache.default_cache_dir`.
        ffmpeg_bin: Name/path of the ffmpeg executable (also handed to yt-dlp).
        ffprobe_bin: Name/path of the ffprobe executable.
        max_download_mb: Reject audio streams larger than this many megabytes.
        max_duration_sec: Reject videos longer than this many seconds.
        cookies_from_browser: Read sign-in cookies from this browser's profile (a yt-dlp
            browser name such as ``"firefox"``).
        cookies_file: Read sign-in cookies from this Netscape cookies.txt file instead.
            It is only read, never written.

    Returns:
        An :class:`AudioSource` describing the extracted file, with ``peak_dbfs`` set so
        a silent download can be flagged.

    Raises:
        InvalidInputError: If ``url`` is not a link (``UnsupportedPlatformError`` and
            ``UnsupportedLinkError`` for an unsupported site or a link that is not a
            single post).
        PlatformUnavailableError: If the active yt-dlp can't import from the site.
        LiveStreamError: If ``url`` is a live or upcoming stream.
        FileTooLargeError: If the video exceeds ``max_duration_sec`` or its audio
            exceeds ``max_download_mb``.
        NoAudioStreamError: If the post has no audio.
        CookiesError: If the chosen cookies can't be read.
        ExtractionError (or a subclass): If the post cannot be fetched.
        FileNotFoundError: If ffmpeg is missing or the expected output file is not
            produced.
    """
    text = parse_link(url)
    platform = platform_for_url(text)
    link: Optional[ResolvedLink] = None
    if not is_share_link(text, platform):
        try:
            link = match_link(text, platform)
        except UnsupportedLinkError:
            # A missing or renamed extractor explains a refused link better.
            compat.require_available(platform)
            raise
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else _cache.default_cache_dir()

    def cached(link: ResolvedLink) -> Optional[AudioSource]:
        if not use_cache:
            return None
        source_id = _source_id(link.cache_key, audio_format, audio_quality)
        hit = _cache.load(resolved_cache_dir, source_id)
        if hit is not None:
            _emit(progress_callback, stage="cache", status="hit", percent=100.0)
        return hit

    # A cached import needs neither the network nor a working platform.
    if link is not None and (hit := cached(link)) is not None:
        return hit
    compat.require_available(platform)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = filename if filename is not None else DEFAULT_STEM
    max_bytes = max_download_mb * 1024 * 1024

    cookies: Optional[str] = None
    cookie_text: Optional[str] = None
    if cookies_from_browser:
        cookies = cookies_from_browser
    elif cookies_file:
        cookie_text = _read_cookies_file(cookies_file)
        cookies = "file"
    js_runtimes = _js_runtimes()

    def ydl_opts(platform: Platform) -> dict:
        opts = {
            "format": "bestaudio/best",
            "outtmpl": str(out_dir / f"{stem}.%(ext)s"),
            "quiet": quiet,
            "no_warnings": quiet,
            "noprogress": quiet,
            "logger": _YtdlpLogger(),
            # Only the platform's single-post extractors: a post that hands over to another
            # site fails ("No suitable extractor") instead of downloading from it.
            "allowed_extractors": [
                re.escape(compat.extractor_class(key).IE_NAME.lower())
                for key in platform.extractors
            ],
            # Honour a link to one item of a post (x.com/…/status/…/video/2).
            "noplaylist": True,
            # A fixed stem can meet leftovers of an earlier attempt; never resume or reuse them.
            "overwrites": True,
            "continuedl": False,
            # yt-dlp derives ffprobe from the same folder.
            "ffmpeg_location": runtime.resolve_executable(ffmpeg_bin),
            "max_filesize": max_bytes,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": audio_format,
                    "preferredquality": audio_quality,
                }
            ],
        }
        if cookies_from_browser:
            opts["cookiesfrombrowser"] = (cookies_from_browser,)
        elif cookie_text is not None:
            # A fresh stream per YoutubeDL: yt-dlp reads it once and writes the jar back.
            opts["cookiefile"] = io.StringIO(cookie_text)
        if js_runtimes is not None:
            opts["js_runtimes"] = js_runtimes
        if progress_callback is not None:
            opts["progress_hooks"] = [_make_download_hook(progress_callback)]
            # yt-dlp runs its own ffmpeg for the transcode; reporting before it starts lets
            # a callback that cancels (the app closing) stop the job while nothing is being
            # written.
            opts["postprocessor_hooks"] = [_make_postprocessor_hook(progress_callback)]
        return opts

    # Imported here, not at module load: ytdlp_updates.activate() must run first so a
    # verified downloaded yt-dlp can take precedence over the bundled copy.
    yt_dlp = import_yt_dlp()

    _emit(progress_callback, stage="metadata", status="start")
    try:
        with contextlib.ExitStack() as stack:
            ydl = stack.enter_context(yt_dlp.YoutubeDL(ydl_opts(platform)))
            if link is None:
                # A share link: one request to find the post it points at.
                link = resolve_link(url, ydl)
                if link.platform.id != platform.id:
                    # A t.co link can lead to another platform, with other extractors.
                    platform = link.platform
                    compat.require_available(platform)
                    ydl = stack.enter_context(yt_dlp.YoutubeDL(ydl_opts(platform)))
                if (hit := cached(link)) is not None:
                    return hit
            info = _fetch_metadata(ydl, link)
            info = ydl.process_ie_result(pick_media(info, link), download=False)
            _check_limits(info, max_download_mb, max_duration_sec)
            _check_has_audio(info, platform)
            info = ydl.process_ie_result(info, download=True)
    except ExtractionError:
        raise
    except Exception as err:
        if not is_ytdlp_failure(err):
            raise
        mapped = classify(err, platform, cookies)
        _log.warning(
            "%s import failed (yt-dlp %s) for %s: %s -> %s",
            platform.id, compat.ytdlp_version(), link.url if link else url, err,
            type(mapped).__name__,
        )
        raise mapped from err

    # After post-processing the file has the requested audio extension.
    result = out_dir / f"{stem}.{audio_format}"
    if not result.exists():
        # yt-dlp skips (without raising) a stream whose real size exceeds max_filesize.
        raise FileTooLargeError(
            f"This video's audio is larger than the {max_download_mb} MB limit."
        )

    # Probe + working copy + AudioSource + cache-save are shared with the upload
    # importer; only acquisition (the yt-dlp download above) is link-specific.
    return finalize_source(
        result,
        source_id=_source_id(link.cache_key, audio_format, audio_quality),
        title=info.get("title") or result.stem,
        source_kind=platform.id,
        source_url=link.url,
        create_working_copy=create_working_copy,
        normalize_loudness=normalize_loudness,
        measure_peak=True,
        use_cache=use_cache,
        cache_dir=resolved_cache_dir,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        progress_callback=progress_callback,
    )
